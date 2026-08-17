import { describe, expect, it } from "vitest";
import {
  AUTO_REPLY_ELIGIBLE_CATEGORIES,
  TRIAGE_CATEGORIES,
  isAutoReplyEligible,
} from "./index";

describe("triage categories", () => {
  it("has exactly six fixed categories", () => {
    expect(TRIAGE_CATEGORIES).toHaveLength(6);
  });

  it("marks urgent as never auto-reply eligible", () => {
    expect(isAutoReplyEligible("urgent")).toBe(false);
  });

  it("marks personal as never auto-reply eligible", () => {
    expect(isAutoReplyEligible("personal")).toBe(false);
  });

  it("marks comercial, suport and facturacio as auto-reply eligible", () => {
    expect(isAutoReplyEligible("comercial")).toBe(true);
    expect(isAutoReplyEligible("suport")).toBe(true);
    expect(isAutoReplyEligible("facturacio")).toBe(true);
  });

  it("keeps the eligible list a subset of the fixed categories", () => {
    for (const category of AUTO_REPLY_ELIGIBLE_CATEGORIES) {
      expect(TRIAGE_CATEGORIES).toContain(category);
    }
  });
});

describe("package barrel", () => {
  it("keeps server-only modules out, since `app/` client code imports it", async () => {
    // The Drizzle schema pulls in drizzle-orm and `token-encryption` pulls in
    // `node:crypto`; both are reached via their own subpath exports instead.
    const barrel = await import("./index");
    expect(Object.keys(barrel)).not.toContain("tenants");
    expect(Object.keys(barrel)).not.toContain("encryptToken");
  });
});
