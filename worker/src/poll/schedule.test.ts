import { drizzle } from "drizzle-orm/pg-proxy";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "../poll-interval";
import { MAILBOX_POLL_QUEUE } from "../queue/mailbox-poll";
import { queueMailboxPolls, startMailboxPollSchedule } from "./schedule";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const MAILBOX_ID = "22222222-2222-2222-2222-222222222222";

/** `listPollableMailboxAccounts` selects the id and the tenant, in that order. */
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

describe("queueMailboxPolls", () => {
  it("queues one poll job per connected mailbox this worker can poll", async () => {
    const { db, queries } = createDb([[MAILBOX_ID, TENANT_ID]]);
    const { boss, send } = createBoss();

    await queueMailboxPolls(boss, db);

    // A mailbox whose grant is gone would only produce a failing job every 2
    // minutes, so it is left out of the query rather than filtered later.
    expect(queries[0]!.sql).toContain('"refresh_token_encrypted" is not null');
    expect(queries[0]!.params).toContain("microsoft");
    expect(send).toHaveBeenCalledWith(
      MAILBOX_POLL_QUEUE,
      { tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID },
      expect.objectContaining({
        // One pending job per mailbox: a poll that outlives the 2-minute tick
        // must not leave a queue of duplicate polls behind it.
        singletonKey: `${TENANT_ID}:${MAILBOX_ID}`,
      }),
    );
  });

  it("sends nothing when no mailbox is connected", async () => {
    const { db } = createDb([]);
    const { boss, send } = createBoss();

    await queueMailboxPolls(boss, db);

    expect(send).not.toHaveBeenCalled();
  });
});

describe("startMailboxPollSchedule", () => {
  it("polls on start and then every POLL_INTERVAL_MS", async () => {
    vi.useFakeTimers();
    const { db } = createDb([[MAILBOX_ID, TENANT_ID]]);
    const { boss, send } = createBoss();

    const schedule = startMailboxPollSchedule({ boss, db });
    await vi.advanceTimersByTimeAsync(0);

    // A worker that restarted should not wait two minutes to look at the mail.
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);

    schedule.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps ticking after a tick that failed", async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    const db = drizzle(async () => {
      throw new Error("database unreachable");
    });
    const { boss } = createBoss();

    const schedule = startMailboxPollSchedule({
      boss,
      db,
      onError: (error) => failures.push(error),
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    schedule.stop();

    // Neon dropping a connection must not silently end the polling loop.
    expect(failures).toHaveLength(2);
  });
});
