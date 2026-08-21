import { describe, expect, it } from "vitest";
import { matchesAutoDiscardCriteria } from "./match";

const rule = (senderPatterns: string[] = [], keywordPatterns: string[] = []) => ({
  senderPatterns,
  keywordPatterns,
});

describe("matchesAutoDiscardCriteria", () => {
  it("applies to every thread of the category when no senders or keywords are set", () => {
    expect(
      matchesAutoDiscardCriteria(rule(), {
        fromAddresses: ["anyone@example.com"],
        subject: "Res a veure",
      }),
    ).toBe(true);
  });

  it("matches a sender pattern against any address in the thread, case-insensitively", () => {
    expect(
      matchesAutoDiscardCriteria(rule(["@Newsletter.example.com"]), {
        fromAddresses: ["butlleti@newsletter.example.com"],
        subject: null,
      }),
    ).toBe(true);
  });

  it("refuses a sender rule when no address matches", () => {
    expect(
      matchesAutoDiscardCriteria(rule(["@newsletter.example.com"]), {
        fromAddresses: ["client@acme.com"],
        subject: null,
      }),
    ).toBe(false);
  });

  it("matches a keyword against the subject, case-insensitively", () => {
    expect(
      matchesAutoDiscardCriteria(rule([], ["butlletí"]), {
        fromAddresses: ["client@acme.com"],
        subject: "El nostre Butlletí mensual",
      }),
    ).toBe(true);
  });

  it("refuses a keyword rule when the subject does not contain it", () => {
    expect(
      matchesAutoDiscardCriteria(rule([], ["butlletí"]), {
        fromAddresses: ["client@acme.com"],
        subject: "Pressupost urgent",
      }),
    ).toBe(false);
  });

  it("refuses a keyword rule when the thread has no subject at all", () => {
    expect(
      matchesAutoDiscardCriteria(rule([], ["butlletí"]), {
        fromAddresses: ["client@acme.com"],
        subject: null,
      }),
    ).toBe(false);
  });

  it("matches when either the sender or the keyword hits, with both configured", () => {
    const both = rule(["@newsletter.example.com"], ["butlletí"]);

    expect(
      matchesAutoDiscardCriteria(both, {
        fromAddresses: ["client@acme.com"],
        subject: "El nostre butlletí mensual",
      }),
    ).toBe(true);
    expect(
      matchesAutoDiscardCriteria(both, {
        fromAddresses: ["butlleti@newsletter.example.com"],
        subject: "Pressupost",
      }),
    ).toBe(true);
    expect(
      matchesAutoDiscardCriteria(both, {
        fromAddresses: ["client@acme.com"],
        subject: "Pressupost",
      }),
    ).toBe(false);
  });
});
