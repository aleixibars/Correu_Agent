import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { MAILBOX_POLL_QUEUE } from "./mailbox-poll";
import {
  SINGLE_FLIGHT_QUEUE_POLICY,
  startQueue,
  type QueueHandlers,
} from "./queue-client";
import { RETENTION_PURGE_CRON, RETENTION_PURGE_QUEUE } from "./retention-purge";

/**
 * pg-boss's own semantics, as far as `startQueue` can see them: `createQueue`
 * does nothing when the queue already exists, so a queue keeps the policy it was
 * created with until it is deleted.
 */
const createBoss = (existingPolicies: Record<string, string> = {}) => {
  const calls: string[] = [];
  const policies: Record<string, string | undefined> = { ...existingPolicies };
  const boss = {
    start: vi.fn(async () => {
      calls.push("start");
    }),
    createQueue: vi.fn(async (name: string, options?: { policy?: string }) => {
      calls.push(`createQueue:${name}`);
      policies[name] ??= options?.policy ?? "standard";
    }),
    getQueue: vi.fn(async (name: string) =>
      policies[name] === undefined ? null : { name, policy: policies[name] },
    ),
    deleteQueue: vi.fn(async (name: string) => {
      calls.push(`deleteQueue:${name}`);
      delete policies[name];
    }),
    schedule: vi.fn(async (name: string) => {
      calls.push(`schedule:${name}`);
    }),
    work: vi.fn(async (name: string) => {
      calls.push(`work:${name}`);
      return "worker-1";
    }),
  } as unknown as PgBoss;
  return { boss, calls, policyOf: (name: string) => policies[name] };
};

const handlers: QueueHandlers = {
  mailboxPoll: vi.fn(async () => ({ polled: [], threads: [], failed: [] })),
  retentionPurge: vi.fn(async () => ({ purged: 0 })),
};

describe("startQueue", () => {
  it("creates each queue before consuming it", async () => {
    const { boss, calls } = createBoss();

    await startQueue(boss, handlers);

    // work() on a queue that does not exist yet would never receive a job.
    expect(calls.indexOf("start")).toBe(0);
    expect(calls.indexOf(`createQueue:${MAILBOX_POLL_QUEUE}`)).toBeLessThan(
      calls.indexOf(`work:${MAILBOX_POLL_QUEUE}`),
    );
    expect(calls.indexOf(`createQueue:${RETENTION_PURGE_QUEUE}`)).toBeLessThan(
      calls.indexOf(`work:${RETENTION_PURGE_QUEUE}`),
    );
    // Without a singleton policy the singletonKey on each job is inert and a
    // slow job leaves a queue of duplicates behind it.
    expect(boss.createQueue).toHaveBeenCalledWith(MAILBOX_POLL_QUEUE, {
      policy: SINGLE_FLIGHT_QUEUE_POLICY,
    });
    expect(boss.work).toHaveBeenCalledWith(
      MAILBOX_POLL_QUEUE,
      handlers.mailboxPoll,
    );
    expect(boss.work).toHaveBeenCalledWith(
      RETENTION_PURGE_QUEUE,
      handlers.retentionPurge,
    );
  });

  it("puts the retention purge on pg-boss's daily cron", async () => {
    const { boss, calls } = createBoss();

    await startQueue(boss, handlers);

    // The 90-day purge has no tick of its own: pg-boss owns the schedule, so a
    // worker restart does not re-run it and two workers do not both fire it.
    expect(boss.schedule).toHaveBeenCalledWith(
      RETENTION_PURGE_QUEUE,
      RETENTION_PURGE_CRON,
      {},
      expect.objectContaining({ singletonKey: RETENTION_PURGE_QUEUE }),
    );
    expect(calls.indexOf(`createQueue:${RETENTION_PURGE_QUEUE}`)).toBeLessThan(
      calls.indexOf(`schedule:${RETENTION_PURGE_QUEUE}`),
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

    expect(calls).toContain(`deleteQueue:${MAILBOX_POLL_QUEUE}`);
    expect(policyOf(MAILBOX_POLL_QUEUE)).toBe(SINGLE_FLIGHT_QUEUE_POLICY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("standard"));
    warn.mockRestore();
  });

  it("leaves a queue already on the right policy alone", async () => {
    const { boss, calls } = createBoss({
      [MAILBOX_POLL_QUEUE]: SINGLE_FLIGHT_QUEUE_POLICY,
      [RETENTION_PURGE_QUEUE]: SINGLE_FLIGHT_QUEUE_POLICY,
    });

    await startQueue(boss, handlers);

    expect(calls.some((call) => call.startsWith("deleteQueue"))).toBe(false);
    expect(boss.work).toHaveBeenCalled();
  });
});
