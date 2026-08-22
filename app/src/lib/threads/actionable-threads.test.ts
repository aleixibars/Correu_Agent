// What "pendents/urgents" means on the dashboard home (context.md §2): threads
// with a live draft waiting on the reviewer, or urgent threads that have not
// been closed out yet. A thread still awaiting triage never belongs here —
// see below. Pure filter, so it is tested without a database.

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

  it("keeps an urgent thread even once triaged", () => {
    const threads = [thread({ category: "urgent", status: "triaged" })];

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
