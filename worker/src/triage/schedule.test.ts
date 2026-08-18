import { drizzle } from "drizzle-orm/pg-proxy";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "../poll-interval";
import { THREAD_TRIAGE_QUEUE } from "../queue/thread-triage";
import { queueThreadTriage, startThreadTriageSchedule } from "./schedule";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";

/** `listThreadsAwaitingTriage` selects the id and the tenant, in that order. */
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

describe("queueThreadTriage", () => {
  it("queues one triage job per thread still waiting for a category", async () => {
    const { db, queries } = createDb([[THREAD_ID, TENANT_ID]]);
    const { boss, send } = createBoss();

    await expect(queueThreadTriage(boss, db)).resolves.toBe(1);

    expect(queries[0]!.sql).toContain('"triaged_at" is null');
    // A thread the poll created but has not written the mail of yet is not
    // classifiable: queueing it would spend an Anthropic call on a subject line.
    expect(queries[0]!.sql).toContain('from "messages"');
    expect(send).toHaveBeenCalledWith(
      THREAD_TRIAGE_QUEUE,
      { tenantId: TENANT_ID, threadId: THREAD_ID },
      expect.objectContaining({ singletonKey: `${TENANT_ID}:${THREAD_ID}` }),
    );
  });

  it("does not count a job the queue dropped as a duplicate", async () => {
    const { db } = createDb([[THREAD_ID, TENANT_ID]]);
    const boss = {
      // What pg-boss answers when this thread already has a triage waiting.
      send: vi.fn(async () => null),
    } as unknown as PgBoss;

    await expect(queueThreadTriage(boss, db)).resolves.toBe(0);
  });
});

describe("startThreadTriageSchedule", () => {
  it("looks for untriaged threads immediately and then every interval", async () => {
    vi.useFakeTimers();
    const { db, queries } = createDb([]);
    const { boss } = createBoss();

    const schedule = startThreadTriageSchedule({ boss, db });
    await vi.advanceTimersByTimeAsync(0);
    expect(queries).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(queries).toHaveLength(2);

    schedule.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(queries).toHaveLength(2);
  });

  it("keeps ticking after a tick fails", async () => {
    // A thread left untriaged is picked up by the next tick; ending the loop
    // would leave every new thread unclassified until the worker restarts.
    vi.useFakeTimers();
    const db = drizzle(async () => {
      throw new Error("Neon dropped the connection");
    });
    const { boss } = createBoss();
    const onError = vi.fn();

    const schedule = startThreadTriageSchedule({ boss, db, onError });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(onError).toHaveBeenCalledTimes(2);
    schedule.stop();
  });
});
