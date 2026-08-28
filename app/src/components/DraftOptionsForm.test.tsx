// El formulari d'aprovació (context.md §2). `renderToStaticMarkup` només
// comprova el primer render, que és el que veu qui encara no té JavaScript:
// els tres camps de destinataris hi surten ja plens amb el que enviaria el fil,
// de manera que aprovar sense tocar res envia el mateix correu d'abans.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import { DraftOptionsForm } from "./DraftOptionsForm";

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";

const render = (
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

describe("DraftOptionsForm", () => {
  it("shows the three recipient fields filled with what the reply would carry", () => {
    const markup = render({
      toAddresses: ["client@example.com"],
      ccAddresses: ["copia@example.com", "segona@example.com"],
      bccAddresses: ["arxiu@example.com"],
    });

    expect(markup).toContain("Per a");
    expect(markup).toContain("Cc");
    expect(markup).toContain("Cco");
    expect(markup).toContain('id="toAddresses"');
    expect(markup).toContain('value="client@example.com"');
    expect(markup).toContain('value="copia@example.com, segona@example.com"');
    expect(markup).toContain('value="arxiu@example.com"');
  });

  it("leaves a field the thread says nothing about empty", () => {
    const markup = render({ ccAddresses: [], bccAddresses: [] });

    expect(markup).toContain('name="ccAddresses" type="text" autoComplete="off" value=""');
    expect(markup).toContain('name="bccAddresses" type="text" autoComplete="off" value=""');
  });

  it("still carries the draft and its text", () => {
    const markup = render({ options: [{ label: "Resposta", body: "Bon dia" }] });

    expect(markup).toContain(`name="draftId" value="${DRAFT_ID}"`);
    expect(markup).toContain("Bon dia");
    expect(markup).toContain("Aprova i envia");
  });

  it("offers the options when the model wrote more than one", () => {
    const markup = render({
      options: [
        { label: "Afirmatiu", body: "Sí" },
        { label: "Negatiu", body: "No" },
      ],
    });

    expect(markup).toContain("Tria una resposta");
    expect(markup).toContain("Afirmatiu");
    expect(markup).toContain("Negatiu");
  });
});
