import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { MAILBOX_POLL_QUEUE } from "./mailbox-poll";
import { QUEUE_POLICY, startQueue } from "./queue-client";
import { THREAD_TRIAGE_QUEUE } from "./thread-triage";

/**
 * pg-boss's own semantics, as far as `startQueue` can see them: `createQueue`
 * does nothing when the queue already exists, so a queue keeps the policy it was
 * created with until it is deleted.
 */
const createBoss = (existingPolicies: Record<string, string> = {}) => {
  const calls: string[] = [];
  const policies = new Map(Object.entries(existingPolicies));
  const boss = {
    start: vi.fn(async () => {
      calls.push("start");
    }),
    createQueue: vi.fn(async (name: string, options?: { policy?: string }) => {
      calls.push("createQueue");
      if (!policies.has(name)) policies.set(name, options?.policy ?? "standard");
    }),
    getQueue: vi.fn(async (name: string) => {
      const policy = policies.get(name);
      return policy === undefined ? null : { name, policy };
    }),
    deleteQueue: vi.fn(async (name: string) => {
      calls.push("deleteQueue");
      policies.delete(name);
    }),
    work: vi.fn(async () => {
      calls.push("work");
      return "worker-1";
    }),
  } as unknown as PgBoss;
  return { boss, calls, policyOf: (name: string) => policies.get(name) };
};

const handlers = {
  mailboxPoll: vi.fn(async () => ({ polled: [], threads: [], failed: [] })),
  threadTriage: vi.fn(async () => ({ triaged: [], skipped: [], failed: [] })),
};

describe("startQueue", () => {
  it("creates each queue before consuming it", async () => {
    const { boss, calls } = createBoss();

    await startQueue(boss, handlers);

    // work() on a queue that does not exist yet would never receive a job.
    expect(calls).toEqual([
      "start",
      "createQueue",
      "work",
      "createQueue",
      "work",
    ]);
    // Without a singleton policy the singletonKey on each job is inert and a
    // slow job leaves a queue of duplicates behind it.
    expect(boss.createQueue).toHaveBeenCalledWith(MAILBOX_POLL_QUEUE, {
      policy: QUEUE_POLICY,
    });
    expect(boss.createQueue).toHaveBeenCalledWith(THREAD_TRIAGE_QUEUE, {
      policy: QUEUE_POLICY,
    });
    expect(boss.work).toHaveBeenCalledWith(
      MAILBOX_POLL_QUEUE,
      handlers.mailboxPoll,
    );
    expect(boss.work).toHaveBeenCalledWith(
      THREAD_TRIAGE_QUEUE,
      handlers.threadTriage,
    );
  });

  it("recreates a queue an earlier worker left on another policy", async () => {
    // createQueue is a no-op on an existing queue and pg-boss refuses to change
    // a policy afterwards, so the de-duplication would silently not apply.
    const { boss, calls, policyOf } = createBoss({
      [MAILBOX_POLL_QUEUE]: "standard",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await startQueue(boss, handlers);

    expect(calls).toEqual([
      "start",
      "createQueue",
      "deleteQueue",
      "createQueue",
      "work",
      "createQueue",
      "work",
    ]);
    expect(policyOf(MAILBOX_POLL_QUEUE)).toBe(QUEUE_POLICY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("standard"));
    warn.mockRestore();
  });

  it("leaves a queue already on the right policy alone", async () => {
    const { boss, calls } = createBoss({
      [MAILBOX_POLL_QUEUE]: QUEUE_POLICY,
      [THREAD_TRIAGE_QUEUE]: QUEUE_POLICY,
    });

    await startQueue(boss, handlers);

    expect(calls).not.toContain("deleteQueue");
    expect(boss.work).toHaveBeenCalledTimes(2);
  });
});
