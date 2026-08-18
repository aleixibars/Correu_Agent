// Feeding the drafting queue (context.md §2). Like triage, the tick asks the
// database which triaged threads have no reply written for the mail that
// arrived rather than being told by the job that just triaged them: a thread
// whose drafting job was lost — or failed for good — is picked up by the next
// tick instead of waiting forever.

import {
  and,
  asc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgBoss } from "pg-boss";
import { DRAFT_ELIGIBLE_CATEGORIES } from "@correu-agent/shared";
import { drafts, messages, threads } from "@correu-agent/shared/db/schema";
import { POLL_INTERVAL_MS } from "../poll-interval";
import { THREAD_DRAFT_QUEUE, type ThreadDraftJobData } from "../queue/thread-draft";

/**
 * How many threads one tick queues. The PoC polls a single mailbox, so this is
 * only a ceiling for the first tick after a backlog: what it leaves behind is
 * queued two minutes later.
 */
const BATCH_SIZE = 200;

export const listThreadsAwaitingDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
): Promise<{ id: string; tenantId: string }[]> =>
  db
    .select({ id: threads.id, tenantId: threads.tenantId })
    .from(threads)
    .where(
      and(
        // A reply is written in the register the category sets, so drafting
        // waits for triage (context.md §4).
        isNotNull(threads.triagedAt),
        // Newsletters and spam are archived, never answered (context.md §2).
        inArray(threads.category, [...DRAFT_ELIGIBLE_CATEGORIES]),
        isNotNull(threads.lastMessageAt),
        // The newest mail of the thread has to be one that is waiting for an
        // answer. A thread the mailbox itself had the last word in needs
        // nothing, and without this it would be queued on every tick for the
        // rest of its life — the drafting job would answer `null` each time,
        // and the oldest of those dead threads would crowd the batch out of
        // the mail that does need drafting. It also covers the thread whose
        // mail the poll has not written yet: `last_message_at` is stamped on
        // the thread row one statement before the messages land.
        exists(
          db
            .select({ one: sql`1` })
            .from(messages)
            .where(
              and(
                eq(messages.threadId, threads.id),
                eq(messages.direction, "inbound"),
                gte(messages.sentAt, threads.lastMessageAt),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(drafts)
            .where(
              and(
                eq(drafts.threadId, threads.id),
                or(
                  // A draft written after the newest mail arrived answers the
                  // thread as it stands — whatever became of it. Comparing
                  // against the mail rather than against a draft status is what
                  // stops a discarded draft from being written again every two
                  // minutes, while new mail still earns a new one.
                  gt(drafts.createdAt, threads.lastMessageAt),
                  // A draft still waiting for the user holds the thread's only
                  // pending slot (`drafts_thread_pending_idx`), so newer mail
                  // cannot be drafted for until that one is answered. Queueing
                  // it would only pay Sonnet for a row that cannot be written.
                  eq(drafts.status, "pending"),
                ),
              ),
            ),
        ),
      ),
    )
    // Oldest mail first: a thread waiting since the previous tick is answered
    // before one that arrived a second ago.
    .orderBy(asc(threads.lastMessageAt))
    .limit(BATCH_SIZE);

/**
 * Queues one drafting job per thread still waiting for a reply and reports how
 * many were really created — a thread whose previous job is still waiting is
 * skipped by the queue, not queued twice.
 */
export const queueThreadDrafts = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  boss: PgBoss,
  db: PgDatabase<T, TSchema>,
): Promise<number> => {
  const pending = await listThreadsAwaitingDraft(db);
  let queued = 0;

  for (const thread of pending) {
    const data: ThreadDraftJobData = {
      tenantId: thread.tenantId,
      threadId: thread.id,
    };
    // The thread is the singleton key: every tick sees a thread that is still
    // being drafted, and it must not stack a second job behind the first.
    const jobId = await boss.send(THREAD_DRAFT_QUEUE, data, {
      singletonKey: `${thread.tenantId}:${thread.id}`,
    });
    if (jobId) queued += 1;
  }

  return queued;
};

export interface ThreadDraftSchedule {
  stop: () => void;
}

export interface ThreadDraftScheduleDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  boss: PgBoss;
  db: PgDatabase<T, TSchema>;
  onError?: (error: unknown) => void;
}

/**
 * Starts the drafting cadence on the same 2-minute beat as the poll and the
 * triage that feed it (context.md §8) and returns a handle to stop it. A failing
 * tick is reported and the next one still runs.
 */
export const startThreadDraftSchedule = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  boss,
  db,
  onError = (error) => console.error("Thread draft scheduling failed:", error),
}: ThreadDraftScheduleDeps<T, TSchema>): ThreadDraftSchedule => {
  const tick = (): void => {
    queueThreadDrafts(boss, db).catch(onError);
  };

  // A worker that just restarted should not wait two minutes to answer the mail
  // the previous one triaged.
  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
};
