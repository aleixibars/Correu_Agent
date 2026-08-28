// @vitest-environment jsdom

// El compte enrere abans d'enviar (issue #80): "Enviar" no crida mai el
// Server Action de seguida — obre un pop-up amb 7 segons per penedir-se'n. La
// prova munta el component de debò perquè tot el retard passa al navegador:
// només si el compte enrere arriba a zero surt la petició cap al proveïdor.
//
// I el formulari d'aprovació també porta el selector de fitxers (context.md
// §2): els adjunts han de ser dins del `FormData` que el compte enrere acaba
// enviant, i una tria massa gran no ha d'arribar ni a obrir-lo.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import {
  MAX_ATTACHMENTS_BYTES,
  MAX_ATTACHMENTS_LABEL,
} from "../lib/mailbox/reply-attachments";
import { DraftOptionsForm } from "./DraftOptionsForm";

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";

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
      approveDraft={approveDraft}
    />,
  );
};

const approve = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
};

const attach = (...files: File[]): void => {
  const input = screen.getByLabelText(/Adjunta documents/);
  // `files` només té getter a jsdom: assignar-lo amb `fireEvent` no arrelaria.
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
};

const fileOf = (name: string, bytes: number): File =>
  new File([new Uint8Array(bytes)], name, { type: "application/pdf" });

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

  it("offers to attach several files to the reply", () => {
    show();

    const input = screen.getByLabelText(/Adjunta documents/);

    expect(input).toHaveProperty("type", "file");
    expect(input).toHaveProperty("name", "attachments");
    expect(input).toHaveProperty("multiple", true);
  });

  // El selector ha de viure dins del mateix formulari que el compte enrere
  // captura: si en quedés fora — el fil el pinta `DraftReviewStages`, amb més
  // d'un formulari germà —, els fitxers no arribarien al Server Action i el
  // correu sortiria sense adjunts sense dir-ho enlloc.
  it("carries the file field in the FormData the countdown sends", () => {
    show();

    approve();
    tick(7);

    const formData = approveDraft.mock.calls[0]?.[0] as FormData;
    // Un selector sense tocar hi posa una part buida, que `readReplyAttachments`
    // descarta; el que es comprova aquí és que el camp hi viatja.
    expect(formData.getAll("attachments")).toHaveLength(1);
    expect(formData.get("attachments")).toBeInstanceOf(File);
  });

  // La mida és el motiu pel qual un enviament pot fallar a mig camí, així que
  // el límit es diu abans d'escollir el fitxer, no després d'intentar-ho.
  it("says out loud how much a reply may carry", () => {
    show();

    expect(
      screen.getByLabelText(/Adjunta documents/, { selector: "input" }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(MAX_ATTACHMENTS_LABEL);
  });

  // El compte enrere no ha de ser el lloc on s'assabenta que el correu no
  // sortirà: una tria massa gran no arriba ni a obrir-lo.
  it("refuses to start the countdown when the files are over the limit", () => {
    show();

    attach(fileOf("gran.pdf", MAX_ATTACHMENTS_BYTES + 1));

    expect(screen.getByRole("alert").textContent).toContain(
      MAX_ATTACHMENTS_LABEL,
    );
    expect(screen.getByRole("button", { name: "Enviar" })).toHaveProperty(
      "disabled",
      true,
    );
    approve();
    tick(60);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(approveDraft).not.toHaveBeenCalled();
  });
});
