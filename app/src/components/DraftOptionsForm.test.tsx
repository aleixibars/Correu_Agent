// El formulari d'aprovació (context.md §2). `renderToStaticMarkup` només veu el
// primer render, que és el que rep qui encara no té JavaScript: el selector de
// fitxers hi ha de ser i el formulari s'ha d'enviar com a `multipart/form-data`,
// perquè un adjunt no viatja en un enviament codificat com a formulari pla.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import { MAX_ATTACHMENTS_LABEL } from "../lib/mailbox/reply-attachments";
import { DraftOptionsForm } from "./DraftOptionsForm";

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";

const options: DraftOption[] = [{ label: "Afirmativa", body: "Sí, us el passem." }];

const render = (): string =>
  renderToStaticMarkup(
    <DraftOptionsForm
      draftId={DRAFT_ID}
      options={options}
      approveDraft={vi.fn()}
    />,
  );

describe("DraftOptionsForm", () => {
  it("offers to attach several files to the reply", () => {
    const markup = render();

    expect(markup).toContain('type="file"');
    expect(markup).toContain('name="attachments"');
    expect(markup).toContain("multiple");
    // React manté la grafia de la prop en el marcatge; l'HTML llegeix
    // l'atribut sense distingir majúscules.
    expect(markup).toMatch(/enctype="multipart\/form-data"/i);
  });

  // La mida és el motiu pel qual un enviament pot fallar a mig camí, així que
  // el límit es diu abans d'escollir el fitxer, no després d'intentar-ho.
  it("says out loud how much a reply may carry", () => {
    expect(render()).toContain(MAX_ATTACHMENTS_LABEL);
  });
});
