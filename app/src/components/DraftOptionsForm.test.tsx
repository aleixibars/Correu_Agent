// @vitest-environment jsdom

// Dues coses que passen al navegador, i per això el component es munta de debò
// aquí:
//
// - El compte enrere abans d'enviar (issue #80): "Enviar" no crida mai el
//   Server Action de seguida — obre un pop-up amb 7 segons per penedir-se'n, i
//   només si arriba a zero surt la petició cap al proveïdor.
// - L'autoguardat del text mentre s'edita (issue #75): d'on parteix l'edició en
//   arribar a l'etapa de resposta (issue #82), i quan surt la crida que el
//   desa — cada minut, en amagar la pestanya i en marxar del fil. Què escriu
//   l'acció a la base de dades el proven `actions.test.ts` i
//   `save-draft-edit.test.ts`.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import { DraftOptionsForm } from "./DraftOptionsForm";

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";
const MODEL_TEXT = "Bon dia, us el passem avui mateix.";

const options: DraftOption[] = [
  { label: "Afirmativa", body: "Sí, hi comptem." },
  { label: "Negativa", body: "Ara mateix no ens va bé." },
];

const approveDraft = vi.fn();
const saveDraftEdit = vi.fn<(formData: FormData) => Promise<void>>(
  async () => {},
);

const show = (
  draftOptions: DraftOption[] = options,
  body: string = draftOptions[0]?.body ?? "",
): void => {
  render(
    <DraftOptionsForm
      draftId={DRAFT_ID}
      body={body}
      options={draftOptions}
      approveDraft={approveDraft}
      saveDraftEdit={saveDraftEdit}
    />,
  );
};

/** El primer render sol, per al text i la tria d'on parteix l'edició. */
const staticMarkup = (body: string, draftOptions: DraftOption[] = []): string =>
  renderToStaticMarkup(
    <DraftOptionsForm
      draftId={DRAFT_ID}
      body={body}
      options={draftOptions}
      approveDraft={approveDraft}
      saveDraftEdit={saveDraftEdit}
    />,
  );

const approve = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
};

const tick = (seconds: number): void => {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
};

const typeInto = (text: string): void => {
  fireEvent.change(screen.getByLabelText("Text de la resposta"), {
    target: { value: text },
  });
};

/** Els minuts sencers entre autoguardats. */
const minutes = (count: number): void => tick(count * 60);

/** El text que ha arribat a l'acció d'autoguardar, en ordre de crida. */
const saved = (): string[] =>
  saveDraftEdit.mock.calls.map(([form]) => String(form.get("body")));

/**
 * Amagar la pestanya, i tornar-la a deixar visible: `document` viu tot el
 * fitxer, així que una prova que l'amagués i prou deixaria les següents
 * corrent amb la pestanya amagada.
 */
const hideTab = (): void => {
  const visibility = (state: string): void => {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      configurable: true,
    });
  };
  visibility("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  visibility("visible");
};

beforeEach(() => {
  vi.useFakeTimers();
  approveDraft.mockReset();
  saveDraftEdit.mockClear();
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

  it("starts the editable field from the text it is given", () => {
    const markup = staticMarkup(MODEL_TEXT);

    expect(markup).toContain(MODEL_TEXT);
    expect(markup).toContain('name="body"');
    expect(markup).toContain(`value="${DRAFT_ID}"`);
  });

  // El revisor va marxar del fil a mitja edició i hi torna: el que retroba és
  // el que la pantalla li va autoguardar (issue #75), no el primer text que va
  // escriure el model.
  it("offers the autosaved edit back instead of the model's text", () => {
    const edited = "Bon dia, us el passem dilluns.";

    const markup = staticMarkup(edited, [
      { label: "Afirmatiu", body: MODEL_TEXT },
    ]);

    expect(markup).toContain(edited);
    expect(markup).not.toContain(MODEL_TEXT);
  });

  // L'edició represa que coincideix amb una de les opcions sí que la marca:
  // qui torna al fil havent triat «Negatiu» retroba la tria feta, no cap.
  it("marks the option the resumed text came from", () => {
    const markup = staticMarkup("Ara no podem.", [
      { label: "Afirmatiu", body: MODEL_TEXT },
      { label: "Negatiu", body: "Ara no podem." },
    ]);

    expect(markup.split("Negatiu")[0]).toContain("checked");
    expect(markup.split("Afirmatiu")[0]).not.toContain("checked");
  });

  // Cap opció marcada quan el text ja no és el de cap d'elles: qui ha reprès
  // una edició pròpia no ha triat cap de les respostes del model.
  it("leaves every option unchecked when the text is a resumed edit", () => {
    const markup = staticMarkup("Un text meu", [
      { label: "Afirmatiu", body: MODEL_TEXT },
      { label: "Negatiu", body: "Ara no podem." },
    ]);

    expect(markup).toContain("Afirmatiu");
    expect(markup).not.toContain("checked");
  });
  // L'autoguardat (issue #75): tot el que decideix quan surt la crida passa al
  // navegador, i per això es prova amb el component muntat de debò.
  describe("autoguardat", () => {
    it("parks what the reviewer has written a minute after they write it", () => {
      show();

      typeInto("Un text a mitges");
      expect(saveDraftEdit).not.toHaveBeenCalled();
      minutes(1);

      expect(saveDraftEdit).toHaveBeenCalledTimes(1);
      const [form] = saveDraftEdit.mock.calls[0]!;
      expect(form.get("draftId")).toBe(DRAFT_ID);
      expect(form.get("body")).toBe("Un text a mitges");
    });

    // Ni una escriptura per minut mentre el revisor només llegeix.
    it("writes nothing while the text has not changed", () => {
      show();

      minutes(5);

      expect(saveDraftEdit).not.toHaveBeenCalled();
    });

    it("does not park the same text twice", () => {
      show();

      typeInto("Un text a mitges");
      minutes(3);

      expect(saved()).toEqual(["Un text a mitges"]);
    });

    // Un camp buit no es desa: deixaria el fil sense cap text on hi havia el
    // del model, i sense manera de recuperar-lo des de la pantalla.
    it("refuses to park an emptied field", () => {
      show();

      typeInto("   \n ");
      minutes(1);

      expect(saveDraftEdit).not.toHaveBeenCalled();
    });

    // Canviar de pestanya o tancar-la: no cal esperar el minut que ve.
    it("parks the text when the tab is hidden", () => {
      show();

      typeInto("Un text a mitges");
      hideTab();

      expect(saved()).toEqual(["Un text a mitges"]);
    });

    // Marxar del fil dins del dashboard desmunta el formulari sense amagar la
    // pestanya, que és l'altra manera de perdre el que s'ha escrit.
    it("parks the text when the reviewer leaves the thread", () => {
      show();

      typeInto("Un text a mitges");
      act(() => {
        cleanup();
      });

      expect(saved()).toEqual(["Un text a mitges"]);
    });

    // Un guardat que no arriba (xarxa caiguda, servidor que falla) no pot
    // deixar el text marcat com a desat: es perdria en silenci fins que el
    // revisor tornés a teclejar.
    it("tries again the minute after a save that does not land", async () => {
      saveDraftEdit.mockRejectedValueOnce(new Error("xarxa caiguda"));
      show();

      typeInto("Un text a mitges");
      minutes(1);
      // Que el rebuig arribi al `catch` abans del minut següent.
      await act(async () => {});
      minutes(1);

      expect(saved()).toEqual(["Un text a mitges", "Un text a mitges"]);
    });
  });
});
