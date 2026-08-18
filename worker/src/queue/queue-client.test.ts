import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { MAILBOX_POLL_QUEUE } from "./mailbox-poll";
import { MAILBOX_POLL_QUEUE_POLICY, startQueue } from "./queue-client";

const createBoss = (policy: string = MAILBOX_POLL_QUEUE_POLICY) => {
  const calls: string[] = [];
  const boss = {
    start: vi.fn(async () => {
      calls.push("start");
    }),
    createQueue: vi.fn(async () => {
      calls.push("createQueue");
    }),
    getQueue: vi.fn(async () => ({ name: MAILBOX_POLL_QUEUE, policy })),
    work: vi.fn(async () => {
      calls.push("work");
      return "worker-1";
    }),
  } as unknown as PgBoss;
  return { boss, calls };
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

  it("warns when an already existing queue has another policy", async () => {
    // createQueue is a no-op on an existing queue and pg-boss refuses to change
    // a policy afterwards, so this would otherwise go unnoticed.
    const { boss } = createBoss("standard");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await startQueue(boss, handleMailboxPoll);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("standard"));
    expect(boss.work).toHaveBeenCalled();
    warn.mockRestore();
  });
});
