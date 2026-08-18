import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { MAILBOX_POLL_QUEUE } from "./mailbox-poll";
import { MAILBOX_POLL_QUEUE_POLICY, startQueue } from "./queue-client";

/**
 * pg-boss's own semantics, as far as `startQueue` can see them: `createQueue`
 * does nothing when the queue already exists, so a queue keeps the policy it was
 * created with until it is deleted.
 */
const createBoss = (existingPolicy?: string) => {
  const calls: string[] = [];
  let policy = existingPolicy;
  const boss = {
    start: vi.fn(async () => {
      calls.push("start");
    }),
    createQueue: vi.fn(async (name: string, options?: { policy?: string }) => {
      calls.push("createQueue");
      if (policy === undefined) policy = options?.policy ?? "standard";
    }),
    getQueue: vi.fn(async () =>
      policy === undefined ? null : { name: MAILBOX_POLL_QUEUE, policy },
    ),
    deleteQueue: vi.fn(async () => {
      calls.push("deleteQueue");
      policy = undefined;
    }),
    work: vi.fn(async () => {
      calls.push("work");
      return "worker-1";
    }),
  } as unknown as PgBoss;
  return { boss, calls, currentPolicy: () => policy };
};

const handleMailboxPoll = vi.fn(async () => ({
  polled: [],
  messages: [],
  failed: [],
}));

describe("startQueue", () => {
  it("creates the mailbox-poll queue before consuming it", async () => {
    const { boss, calls } = createBoss();

    await startQueue(boss, handleMailboxPoll);

    // work() on a queue that does not exist yet would never receive a job.
    expect(calls).toEqual(["start", "createQueue", "work"]);
    // Without a singleton policy the singletonKey on each poll job is inert and
    // a slow poll leaves a queue of duplicates behind it.
    expect(boss.createQueue).toHaveBeenCalledWith(MAILBOX_POLL_QUEUE, {
      policy: MAILBOX_POLL_QUEUE_POLICY,
    });
    expect(boss.work).toHaveBeenCalledWith(MAILBOX_POLL_QUEUE, handleMailboxPoll);
  });

  it("recreates a queue an earlier worker left on another policy", async () => {
    // createQueue is a no-op on an existing queue and pg-boss refuses to change
    // a policy afterwards, so the de-duplication would silently not apply.
    const { boss, calls, currentPolicy } = createBoss("standard");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await startQueue(boss, handleMailboxPoll);

    expect(calls).toEqual([
      "start",
      "createQueue",
      "deleteQueue",
      "createQueue",
      "work",
    ]);
    expect(currentPolicy()).toBe(MAILBOX_POLL_QUEUE_POLICY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("standard"));
    warn.mockRestore();
  });

  it("leaves a queue already on the right policy alone", async () => {
    const { boss, calls } = createBoss(MAILBOX_POLL_QUEUE_POLICY);

    await startQueue(boss, handleMailboxPoll);

    expect(calls).not.toContain("deleteQueue");
    expect(boss.work).toHaveBeenCalled();
  });
});
