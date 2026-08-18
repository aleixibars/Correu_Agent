// Feeding the triage queue (context.md §4). The tick asks the database which
// threads still have no category rather than being told by the poll that just
// wrote them: a thread whose triage job was lost — or whose classification
// failed for good — is then picked up by the next tick instead of staying
// unclassified forever.

import { asc, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgBoss } from "pg-boss";
import { threads } from "@correu-agent/shared/db/schema";
import { POLL_INTERVAL_MS } from "../poll-interval";
import { THREAD_TRIAGE_QUEUE, type ThreadTriageJobData } from "../queue/thread-triage";

/**
 * How many threads one tick queues. The PoC polls a single mailbox, so this is
 * only a ceiling for the first tick after a backlog: what it leaves behind is
 * queued two minutes later.
 */
const BATCH_SIZE = 200;

export const listThreadsAwaitingTriage = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
): Promise<{ id: string; tenantId: string }[]> =>
  db
    .select({ id: threads.id, tenantId: threads.tenantId })
    .from(threads)
    .where(isNull(threads.triagedAt))
    // Oldest mail first: a thread waiting since the previous tick is answered
    // before one that arrived a second ago.
    .orderBy(asc(threads.lastMessageAt))
    .limit(BATCH_SIZE);

/**
 * Queues one triage job per untriaged thread and reports how many were really
 * created — a thread whose previous triage is still waiting is skipped by the
 * queue, not queued twice.
 */
export const queueThreadTriage = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  boss: PgBoss,
  db: PgDatabase<T, TSchema>,
): Promise<number> => {
  const pending = await listThreadsAwaitingTriage(db);
  let queued = 0;

  for (const thread of pending) {
    const data: ThreadTriageJobData = {
      tenantId: thread.tenantId,
      threadId: thread.id,
    };
    // The thread is the singleton key: every tick sees a thread that is still
    // being classified, and it must not stack a second job behind the first.
    const jobId = await boss.send(THREAD_TRIAGE_QUEUE, data, {
      singletonKey: `${thread.tenantId}:${thread.id}`,
    });
    if (jobId) queued += 1;
  }

  return queued;
};

export interface ThreadTriageSchedule {
  stop: () => void;
}

export interface ThreadTriageScheduleDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  boss: PgBoss;
  db: PgDatabase<T, TSchema>;
  onError?: (error: unknown) => void;
}

/**
 * Starts the triage cadence on the same 2-minute beat as the poll that feeds it
 * (context.md §8) and returns a handle to stop it. A failing tick is reported
 * and the next one still runs.
 */
export const startThreadTriageSchedule = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  boss,
  db,
  onError = (error) => console.error("Thread triage scheduling failed:", error),
}: ThreadTriageScheduleDeps<T, TSchema>): ThreadTriageSchedule => {
  const tick = (): void => {
    queueThreadTriage(boss, db).catch(onError);
  };

  // A worker that just restarted should not wait two minutes to classify the
  // mail the previous one stored.
  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
};
