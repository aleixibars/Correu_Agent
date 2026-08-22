// What "pendents/urgents" means on the dashboard home (context.md §2): threads
// with a live draft waiting on the reviewer, or urgent threads that have not
// been closed out yet. A thread still awaiting triage, or triaged with no
// draft written for it yet, never belongs here — see below. Pure filter, so
// it is tested without a database.

import { describe, expect, it } from "vitest";
import type { ThreadListItem } from "./list-threads";
import { actionableThreads } from "./actionable-threads";

const thread = (overrides: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id: "thread-1",
  subject: "Assumpte",
  category: "comercial",
  lastMessageAt: null,
  status: "triaged",
  draftId: null,
  ...overrides,
});

describe("actionableThreads", () => {
  it("drops a thread still awaiting triage", () => {
    expect(
      actionableThreads([thread({ status: "awaiting-triage" })]),
    ).toEqual([]);
  });

  it("keeps a thread with a draft pending review", () => {
    const threads = [thread({ status: "draft-pending" })];

    expect(actionableThreads(threads)).toEqual(threads);
  });

  it("drops a triaged thread with no live draft", () => {
    expect(actionableThreads([thread({ status: "triaged" })])).toEqual([]);
  });

  it("drops a thread already replied to", () => {
    expect(actionableThreads([thread({ status: "replied" })])).toEqual([]);
  });

  it("drops a thread whose draft was discarded", () => {
    expect(
      actionableThreads([thread({ status: "draft-discarded" })]),
    ).toEqual([]);
  });

  // Triaged but with no draft yet: nothing waits on the reviewer until the
  // next drafting tick writes one, urgent or not.
  it("drops an urgent thread that is only triaged, with no draft yet", () => {
    expect(
      actionableThreads([thread({ category: "urgent", status: "triaged" })]),
    ).toEqual([]);
  });

  it("keeps an urgent thread once it has a draft pending review", () => {
    const threads = [thread({ category: "urgent", status: "draft-pending" })];

    expect(actionableThreads(threads)).toEqual(threads);
  });

  it("drops an urgent thread once replied to", () => {
    expect(
      actionableThreads([thread({ category: "urgent", status: "replied" })]),
    ).toEqual([]);
  });

  it("drops an urgent thread whose draft was discarded", () => {
    expect(
      actionableThreads([
        thread({ category: "urgent", status: "draft-discarded" }),
      ]),
    ).toEqual([]);
  });

  it("limits the result while keeping the incoming order", () => {
    const threads = [
      thread({ id: "a", status: "draft-pending" }),
      thread({ id: "b", status: "draft-pending" }),
      thread({ id: "c", status: "draft-pending" }),
    ];

    expect(actionableThreads(threads, 2)).toEqual([threads[0], threads[1]]);
  });
});
