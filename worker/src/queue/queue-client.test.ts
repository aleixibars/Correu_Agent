import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { MAILBOX_POLL_QUEUE } from "./mailbox-poll";
import { startQueue } from "./queue-client";

describe("startQueue", () => {
  it("creates the mailbox-poll queue before consuming it", async () => {
    const calls: string[] = [];
    const boss = {
      start: vi.fn(async () => {
        calls.push("start");
      }),
      createQueue: vi.fn(async () => {
        calls.push("createQueue");
      }),
      work: vi.fn(async () => {
        calls.push("work");
        return "worker-1";
      }),
    } as unknown as PgBoss;

    const handleMailboxPoll = vi.fn(async () => ({
      polled: [],
      messages: [],
      failed: [],
    }));

    await startQueue(boss, handleMailboxPoll);

    // work() on a queue that does not exist yet would never receive a job.
    expect(calls).toEqual(["start", "createQueue", "work"]);
    expect(boss.createQueue).toHaveBeenCalledWith(MAILBOX_POLL_QUEUE);
    expect(boss.work).toHaveBeenCalledWith(MAILBOX_POLL_QUEUE, handleMailboxPoll);
  });
});
