import { describe, expect, it } from "vitest";
import {
  THREAD_STATUSES,
  threadStatus,
  threadStatusLabel,
} from "./thread-status";

const at = new Date("2026-08-18T09:00:00Z");

describe("threadStatus", () => {
  it("reports a thread the triage tick has not reached yet", () => {
    expect(threadStatus({ triagedAt: null, draftStatus: null })).toBe(
      "awaiting-triage",
    );
  });

  it("reports a triaged thread with no draft", () => {
    expect(threadStatus({ triagedAt: at, draftStatus: null })).toBe("triaged");
  });

  it("maps every draft state a reviewer acts on", () => {
    expect(threadStatus({ triagedAt: at, draftStatus: "pending" })).toBe(
      "draft-pending",
    );
    expect(threadStatus({ triagedAt: at, draftStatus: "approved" })).toBe(
      "draft-approved",
    );
    expect(threadStatus({ triagedAt: at, draftStatus: "sent" })).toBe(
      "replied",
    );
    expect(threadStatus({ triagedAt: at, draftStatus: "discarded" })).toBe(
      "draft-discarded",
    );
  });

  // A superseded draft was replaced by a regenerated one (context.md §2); the
  // thread is back to having nothing waiting on the reviewer.
  it("ignores a draft that a regeneration replaced", () => {
    expect(threadStatus({ triagedAt: at, draftStatus: "superseded" })).toBe(
      "triaged",
    );
  });
});

describe("threadStatusLabel", () => {
  it("has a Catalan label for every status", () => {
    for (const status of THREAD_STATUSES) {
      expect(threadStatusLabel(status).length).toBeGreaterThan(0);
    }
  });

  it("labels an untriaged thread as pending triage", () => {
    expect(threadStatusLabel("awaiting-triage")).toBe("Pendent de triatge");
  });
});
