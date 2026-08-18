import type { PgBoss } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_CRON_EXPRESSION } from "../poll-interval";
import { MAILBOX_POLL_DISPATCH_QUEUE } from "./mailbox-poll-dispatch";
import { MAILBOX_POLL_QUEUE } from "./mailbox-poll";
import { startQueue } from "./queue-client";

// The wiring under test is which mailboxes get queued, not how they are polled.
vi.mock("../mailbox/gmail-poll", () => ({
  listGmailPollTargets: vi.fn(async () => []),
  pollGmailMailbox: vi.fn(async () => null),
}));

const { listGmailPollTargets } = await import("../mailbox/gmail-poll");

type WorkHandler = (jobs: unknown[]) => Promise<unknown>;

/**
 * pg-boss's own semantics, as far as `startQueue` can see them: `createQueue`
 * does nothing when the queue already exists, so a queue keeps the policy it was
 * created with until it is deleted.
 */
const fakeBoss = (existing: Record<string, string> = {}) => {
  const calls: string[] = [];
  const handlers = new Map<string, WorkHandler>();
  const queues = new Map(Object.entries(existing));
  const boss = {
    start: vi.fn(async () => {
      calls.push("start");
    }),
    createQueue: vi.fn(async (name: string, options?: { policy?: string }) => {
      calls.push(`createQueue:${name}`);
      if (!queues.has(name)) queues.set(name, options?.policy ?? "standard");
    }),
    getQueues: vi.fn(async (names: string[]) =>
      names
        .filter((name) => queues.has(name))
        .map((name) => ({ name, policy: queues.get(name) })),
    ),
    deleteQueue: vi.fn(async (name: string) => {
      calls.push(`deleteQueue:${name}`);
      queues.delete(name);
    }),
    work: vi.fn(async (name: string, handler: unknown) => {
      calls.push(`work:${name}`);
      handlers.set(name, handler as WorkHandler);
      return `worker-${name}`;
    }),
    schedule: vi.fn(async (name: string) => {
      calls.push(`schedule:${name}`);
    }),
    send: vi.fn(async () => "job-1"),
  };
  return { boss: boss as unknown as PgBoss, spy: boss, calls, handlers, queues };
};

const database = {} as Parameters<typeof startQueue>[1];

beforeEach(() => {
  vi.mocked(listGmailPollTargets).mockResolvedValue([]);
});

describe("startQueue", () => {
  it("creates both queues before consuming or scheduling them", async () => {
    const { boss, calls } = fakeBoss();

    await startQueue(boss, database);

    // work() or schedule() on a queue that does not exist yet would never
    // receive a job.
    expect(calls).toEqual([
      "start",
      `createQueue:${MAILBOX_POLL_QUEUE}`,
      `createQueue:${MAILBOX_POLL_DISPATCH_QUEUE}`,
      `work:${MAILBOX_POLL_QUEUE}`,
      `work:${MAILBOX_POLL_DISPATCH_QUEUE}`,
      `schedule:${MAILBOX_POLL_DISPATCH_QUEUE}`,
    ]);
  });

  it("keeps at most one job queued per mailbox and per tick", async () => {
    const { boss, spy } = fakeBoss();

    await startQueue(boss, database);

    // Without it a worker that falls behind comes back to a queue holding one
    // stale job per mailbox per elapsed 2-minute tick.
    for (const queue of [MAILBOX_POLL_QUEUE, MAILBOX_POLL_DISPATCH_QUEUE]) {
      expect(spy.createQueue).toHaveBeenCalledWith(queue, { policy: "short" });
    }
  });

  it("recreates a queue an earlier worker left on another policy", async () => {
    // pg-boss ignores the policy of a queue that already exists and refuses to
    // change it afterwards, so the de-duplication above would silently not apply.
    const { boss, calls, queues } = fakeBoss({
      [MAILBOX_POLL_QUEUE]: "standard",
    });

    await startQueue(boss, database);

    expect(calls.filter((call) => call.endsWith(`:${MAILBOX_POLL_QUEUE}`))).toEqual([
      `createQueue:${MAILBOX_POLL_QUEUE}`,
      `deleteQueue:${MAILBOX_POLL_QUEUE}`,
      `createQueue:${MAILBOX_POLL_QUEUE}`,
      `work:${MAILBOX_POLL_QUEUE}`,
    ]);
    expect(queues.get(MAILBOX_POLL_QUEUE)).toBe("short");
  });

  it("leaves a queue already on the right policy alone", async () => {
    const { boss, calls } = fakeBoss({
      [MAILBOX_POLL_QUEUE]: "short",
      [MAILBOX_POLL_DISPATCH_QUEUE]: "short",
    });

    await startQueue(boss, database);

    expect(calls.some((call) => call.startsWith("deleteQueue:"))).toBe(false);
  });

  it("schedules the fan-out at the polling cadence (context.md §8)", async () => {
    const { boss, spy } = fakeBoss();

    await startQueue(boss, database);

    expect(spy.schedule).toHaveBeenCalledWith(
      MAILBOX_POLL_DISPATCH_QUEUE,
      POLL_CRON_EXPRESSION,
    );
  });

  it("queues one poll per mailbox, without stacking them up", async () => {
    const { boss, spy, handlers } = fakeBoss();
    await startQueue(boss, database);

    const dispatchHandler = handlers.get(MAILBOX_POLL_DISPATCH_QUEUE)!;
    const listedTargets = [
      { tenantId: "tenant-1", mailboxAccountId: "mailbox-1" },
    ];
    vi.mocked(listGmailPollTargets).mockResolvedValue(listedTargets);

    await dispatchHandler([{ id: "tick-1", data: {} }]);

    // A mailbox whose previous poll is still waiting must not be queued again:
    // a slow provider would otherwise pile up a job every two minutes.
    expect(spy.send).toHaveBeenCalledWith(
      MAILBOX_POLL_QUEUE,
      listedTargets[0],
      { singletonKey: "mailbox-1" },
    );
  });
});
