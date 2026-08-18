import { drizzle } from "drizzle-orm/pg-proxy";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "../poll-interval";
import { THREAD_DRAFT_QUEUE } from "../queue/thread-draft";
import { queueThreadDrafts, startThreadDraftSchedule } from "./schedule";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";

/** `listThreadsAwaitingDraft` selects the id and the tenant, in that order. */
const createDb = (rows: unknown[][]) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows };
  });
  return { db, queries };
};

const createBoss = () => {
  const send = vi.fn(async () => "job-1");
  return { boss: { send } as unknown as PgBoss, send };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("queueThreadDrafts", () => {
  it("queues one drafting job per thread still waiting for a reply", async () => {
    const { db, queries } = createDb([[THREAD_ID, TENANT_ID]]);
    const { boss, send } = createBoss();

    await expect(queueThreadDrafts(boss, db)).resolves.toBe(1);

    // Only threads that have been triaged and are worth answering.
    expect(queries[0]!.sql).toContain('"triaged_at" is not null');
    expect(queries[0]!.params).not.toContain("newsletter");
    expect(queries[0]!.params).toContain("comercial");
    // A thread already answered for the mail it holds is not queued again —
    // otherwise a discarded draft would come back every two minutes.
    expect(queries[0]!.sql).toContain('from "drafts"');
    // Nor one whose only draft is still waiting for the user: the thread holds
    // one pending draft at a time, so drafting newer mail now would pay for a
    // row that cannot be written.
    expect(queries[0]!.params).toContain("pending");
    // Nor a thread the mailbox itself had the last word in — it would be queued
    // on every tick forever and crowd out the mail that does need answering.
    expect(queries[0]!.sql).toContain('from "messages"');
    expect(queries[0]!.params).toContain("inbound");
    expect(send).toHaveBeenCalledWith(
      THREAD_DRAFT_QUEUE,
      { tenantId: TENANT_ID, threadId: THREAD_ID },
      expect.objectContaining({ singletonKey: `${TENANT_ID}:${THREAD_ID}` }),
    );
  });

  it("does not count a job the queue dropped as a duplicate", async () => {
    const { db } = createDb([[THREAD_ID, TENANT_ID]]);
    const boss = {
      // What pg-boss answers when this thread already has a draft job waiting.
      send: vi.fn(async () => null),
    } as unknown as PgBoss;

    await expect(queueThreadDrafts(boss, db)).resolves.toBe(0);
  });
});

describe("startThreadDraftSchedule", () => {
  it("looks for threads to answer immediately and then every interval", async () => {
    vi.useFakeTimers();
    const { db, queries } = createDb([]);
    const { boss } = createBoss();

    const schedule = startThreadDraftSchedule({ boss, db });
    await vi.advanceTimersByTimeAsync(0);
    expect(queries).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(queries).toHaveLength(2);

    schedule.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(queries).toHaveLength(2);
  });

  it("keeps ticking after a tick fails", async () => {
    // A thread left unanswered is picked up by the next tick; ending the loop
    // would leave every triaged thread without a draft until the worker restarts.
    vi.useFakeTimers();
    const db = drizzle(async () => {
      throw new Error("Neon dropped the connection");
    });
    const { boss } = createBoss();
    const onError = vi.fn();

    const schedule = startThreadDraftSchedule({ boss, db, onError });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(onError).toHaveBeenCalledTimes(2);
    schedule.stop();
  });
});
