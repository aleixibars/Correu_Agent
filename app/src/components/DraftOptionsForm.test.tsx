// @vitest-environment jsdom

// El formulari d'aprovació (context.md §2). Dues meitats:
//
// - Els camps de destinataris (issue #76): `renderToStaticMarkup` comprova el
//   primer render, que és el que veu qui encara no té JavaScript — els tres
//   camps hi surten ja plens amb el que enviaria el fil, de manera que aprovar
//   sense tocar res envia el mateix correu d'abans.
// - El compte enrere abans d'enviar (issue #80): "Enviar" no crida mai el
//   Server Action de seguida — obre un pop-up amb 7 segons per penedir-se'n. La
//   prova munta el component de debò perquè tot el retard passa al navegador:
//   només si el compte enrere arriba a zero surt la petició cap al proveïdor.

import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import { DraftOptionsForm } from "./DraftOptionsForm";

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";

const renderMarkup = (
  overrides: Partial<{
    options: DraftOption[];
    toAddresses: string[];
    ccAddresses: string[];
    bccAddresses: string[];
  }> = {},
): string =>
  renderToStaticMarkup(
    <DraftOptionsForm
      draftId={DRAFT_ID}
      options={[{ label: "Resposta", body: "Bon dia" }]}
      toAddresses={["client@example.com"]}
      ccAddresses={[]}
      bccAddresses={[]}
      approveDraft={vi.fn()}
      suggestContacts={vi.fn(async () => [])}
      {...overrides}
    />,
  );

/**
 * What a named field would submit, read out of the markup — by the field's id
 * rather than by the attribute string React happens to write, so the assertions
 * are about the form and not about React's rendering order.
 */
const fieldValue = (markup: string, id: string): string | null => {
  const match = markup.match(new RegExp(`<input id="${id}"[^>]*?value="([^"]*)"`));
  return match ? match[1]! : null;
};

const options: DraftOption[] = [
  { label: "Afirmativa", body: "Sí, hi comptem." },
  { label: "Negativa", body: "Ara mateix no ens va bé." },
];

const approveDraft = vi.fn();

const show = (draftOptions: DraftOption[] = options): void => {
  render(
    <DraftOptionsForm
      draftId={DRAFT_ID}
      options={draftOptions}
      toAddresses={["client@example.com"]}
      ccAddresses={[]}
      bccAddresses={[]}
      approveDraft={approveDraft}
      suggestContacts={vi.fn(async () => [])}
    />,
  );
};

const approve = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
};

const tick = (seconds: number): void => {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  approveDraft.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DraftOptionsForm", () => {
  it("shows the three recipient fields filled with what the reply would carry", () => {
    const markup = renderMarkup({
      toAddresses: ["client@example.com"],
      ccAddresses: ["copia@example.com", "segona@example.com"],
      bccAddresses: ["arxiu@example.com"],
    });

    expect(markup).toContain("Per a");
    expect(markup).toContain("Cc");
    expect(markup).toContain("Cco");
    // Several addresses in one field, comma-separated, as a mail client writes
    // them — the same shape the approval action parses back.
    expect(fieldValue(markup, "toAddresses")).toBe("client@example.com");
    expect(fieldValue(markup, "ccAddresses")).toBe(
      "copia@example.com, segona@example.com",
    );
    expect(fieldValue(markup, "bccAddresses")).toBe("arxiu@example.com");
  });

  it("leaves a field the thread says nothing about empty", () => {
    const markup = renderMarkup({ ccAddresses: [], bccAddresses: [] });

    expect(fieldValue(markup, "ccAddresses")).toBe("");
    expect(fieldValue(markup, "bccAddresses")).toBe("");
  });

  // A reply with nobody in `Per a` is refused by the send, but by then the
  // reviewer has lost the page they were editing; the browser stops it first.
  it("asks the browser to refuse an empty Per a and nothing else", () => {
    const markup = renderMarkup();

    expect(markup).toMatch(/<input id="toAddresses"[^>]*required/);
    expect(markup).not.toMatch(/<input id="ccAddresses"[^>]*required/);
    expect(markup).not.toMatch(/<input id="bccAddresses"[^>]*required/);
  });

  it("still carries the draft and its text", () => {
    const markup = renderMarkup({
      options: [{ label: "Resposta", body: "Bon dia" }],
    });

    expect(markup).toContain(`name="draftId" value="${DRAFT_ID}"`);
    expect(markup).toContain("Bon dia");
    // El botó es diu "Enviar" des de la revisió per etapes (issue #82): qui hi
    // arriba ja ha triat respondre, així que l'aprovació ja no es torna a dir.
    expect(markup).toContain("Enviar");
  });

  it("offers the options when the model wrote more than one", () => {
    const markup = renderMarkup({
      options: [
        { label: "Afirmatiu", body: "Sí" },
        { label: "Negatiu", body: "No" },
      ],
    });

    expect(markup).toContain("Tria una resposta");
    expect(markup).toContain("Afirmatiu");
    expect(markup).toContain("Negatiu");
  });

  it("does not send on the click: it opens a countdown of 7 seconds instead", () => {
    show();

    approve();

    expect(approveDraft).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveProperty("ariaModal", "true");
    expect(dialog.textContent).toContain("7");
  });

  // Enfocable des del primer moment: qui es penedeix amb el teclat no ha de
  // buscar el botó a mig compte enrere.
  it("focuses the cancel button as soon as the countdown opens", () => {
    show();

    approve();

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel·la" }),
    );
  });

  it("counts down second by second", () => {
    show();
    approve();

    tick(1);
    expect(screen.getByRole("dialog").textContent).toContain("6");

    tick(5);
    expect(screen.getByRole("dialog").textContent).toContain("1");
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it("sends once the countdown reaches zero, with the text as edited", () => {
    show();
    fireEvent.change(screen.getByLabelText("Text de la resposta"), {
      target: { value: "Text meu" },
    });

    approve();
    tick(7);

    expect(approveDraft).toHaveBeenCalledTimes(1);
    const formData = approveDraft.mock.calls[0]?.[0] as FormData;
    expect(formData.get("draftId")).toBe(DRAFT_ID);
    expect(formData.get("body")).toBe("Text meu");
    // Els destinataris que el revisor tenia a la vista viatgen amb l'enviament.
    expect(formData.get("toAddresses")).toBe("client@example.com");
  });

  // Un navegador carregat pot deixar passar més d'un tic abans que React
  // reaccioni al zero: el compte enrere s'atura a zero i no en negatiu, perquè
  // un negatiu no dispararia mai l'enviament.
  it("still sends once when several seconds elapse between renders", () => {
    show();

    approve();
    tick(60);

    expect(approveDraft).toHaveBeenCalledTimes(1);
  });

  it("never sends when cancelled inside the countdown", () => {
    show();
    approve();

    tick(3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel·la" }));
    tick(60);

    expect(approveDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels with Escape too", () => {
    show();
    approve();

    fireEvent.keyDown(document, { key: "Escape" });
    tick(60);

    expect(approveDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("counts down again after a cancelled attempt, from seven", () => {
    show();
    approve();
    tick(3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel·la" }));

    approve();

    expect(screen.getByRole("dialog").textContent).toContain("7");
  });

  // Enviar de debò triga (el proveïdor, i després la revalidació que desmunta
  // el formulari): un segon clic en aquesta estona seria un segon correu.
  it("keeps the form blocked while the send is still in flight", () => {
    approveDraft.mockReturnValue(new Promise(() => {}));
    show();

    approve();
    tick(7);

    expect(approveDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enviant…" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("re-opens the form with a warning when the send fails", async () => {
    approveDraft.mockRejectedValue(new Error("el proveïdor no respon"));
    show();

    approve();
    tick(7);
    await act(async () => {});

    expect(screen.getByRole("alert").textContent).toContain(
      "No s'ha pogut enviar",
    );
    expect(
      screen.getByRole("button", { name: "Enviar" }),
    ).toHaveProperty("disabled", false);
  });

  // L'avís d'error es queda a la vista fins al següent intent: deixar-lo sota
  // el pop-up diria que ha fallat una cosa que encara està en marxa.
  it("clears the failure notice when a new countdown opens", async () => {
    approveDraft.mockRejectedValue(new Error("el proveïdor no respon"));
    show();
    approve();
    tick(7);
    await act(async () => {});

    approve();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("gives the focus back to the approve button after cancelling", () => {
    show();
    approve();

    fireEvent.click(screen.getByRole("button", { name: "Cancel·la" }));

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Enviar" }),
    );
  });

  // El fons queda tapat: tabular fins al formulari de sota seria sortir del
  // pop-up sense tancar-lo.
  it("keeps the tab key inside the countdown", () => {
    show();
    approve();
    screen.getByLabelText("Text de la resposta").focus();

    const notPrevented = fireEvent.keyDown(document, { key: "Tab" });

    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel·la" }),
    );
  });

  it("still lets an option replace the editable text before approving", () => {
    show();

    fireEvent.click(screen.getByRole("radio", { name: "Negativa" }));

    expect(screen.getByLabelText("Text de la resposta")).toHaveProperty(
      "value",
      "Ara mateix no ens va bé.",
    );
  });
});
