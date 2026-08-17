import { describe, expect, it } from "vitest";
import { TRIAGE_CATEGORIES } from "@correu-agent/shared";
import { categoryLabel } from "./category-labels";

describe("categoryLabel", () => {
  it("has a Catalan label for every triage category", () => {
    for (const category of TRIAGE_CATEGORIES) {
      expect(categoryLabel(category).length).toBeGreaterThan(0);
    }
  });

  it("labels urgent as Urgent", () => {
    expect(categoryLabel("urgent")).toBe("Urgent");
  });
});
