// El text d'on parteix l'edició, un cop el revisor arriba a l'etapa de
// resposta (issue #82). L'autoguardat en si (temporitzador, amagar la pestanya,
// desmuntar el formulari) no es veu al primer render, que és tot el que
// `renderToStaticMarkup` produeix; el que desa l'acció el prova `actions.test.ts`.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import { DraftOptionsForm } from "./DraftOptionsForm";

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";
const MODEL_TEXT = "Bon dia, us el passem avui mateix.";

const render = (body: string, options: DraftOption[] = []): string =>
  renderToStaticMarkup(
    <DraftOptionsForm
      draftId={DRAFT_ID}
      body={body}
      options={options}
      approveDraft={vi.fn()}
      saveDraftEdit={vi.fn(async () => {})}
    />,
  );

describe("DraftOptionsForm", () => {
  it("starts the editable field from the text it is given", () => {
    const markup = render(MODEL_TEXT);

    expect(markup).toContain(MODEL_TEXT);
    expect(markup).toContain('name="body"');
    expect(markup).toContain(`value="${DRAFT_ID}"`);
  });

  // El revisor va marxar del fil a mitja edició i hi torna: el que retroba és
  // el que la pantalla li va autoguardar (issue #75), no el primer text que va
  // escriure el model.
  it("offers the autosaved edit back instead of the model's text", () => {
    const edited = "Bon dia, us el passem dilluns.";

    const markup = render(edited, [{ label: "Afirmatiu", body: MODEL_TEXT }]);

    expect(markup).toContain(edited);
    expect(markup).not.toContain(MODEL_TEXT);
  });

  // L'edició represa que coincideix amb una de les opcions sí que la marca:
  // qui torna al fil havent triat «Negatiu» retroba la tria feta, no cap.
  it("marks the option the resumed text came from", () => {
    const markup = render("Ara no podem.", [
      { label: "Afirmatiu", body: MODEL_TEXT },
      { label: "Negatiu", body: "Ara no podem." },
    ]);

    expect(markup.split("Negatiu")[0]).toContain("checked");
    expect(markup.split("Afirmatiu")[0]).not.toContain("checked");
  });

  // Cap opció marcada quan el text ja no és el de cap d'elles: qui ha reprès
  // una edició pròpia no ha triat cap de les respostes del model.
  it("leaves every option unchecked when the text is a resumed edit", () => {
    const markup = render("Un text meu", [
      { label: "Afirmatiu", body: MODEL_TEXT },
      { label: "Negatiu", body: "Ara no podem." },
    ]);

    expect(markup).toContain("Afirmatiu");
    expect(markup).not.toContain("checked");
  });
});
