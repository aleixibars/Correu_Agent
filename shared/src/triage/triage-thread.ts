// Triaging one stored thread (context.md §4): read the mail already in the
// database, ask Haiku for a category, write it down and record why.

import { and, asc, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { messages, threads } from "../db/schema";
import {
  MAX_THREAD_MESSAGES,
  classifyThread,
  type ThreadClassification,
  type TriageMessagesClient,
} from "./classify";

export interface TriageThreadInput {
  tenantId: string;
  threadId: string;
  /** Stamp for the classification; defaults to the wall clock. */
  now?: Date;
}

export type TriagedThread = ThreadClassification & { threadId: string };

/**
 * Classifies one thread and stores the result, or does nothing and answers
 * `null` — the thread is gone, it was already triaged (a reply never re-triages
 * it, context.md §4), or another worker triaged it while this one was asking
 * the model.
 */
export const triageThread = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  client: TriageMessagesClient,
  { tenantId, threadId, now = new Date() }: TriageThreadInput,
): Promise<TriagedThread | null> => {
  const [thread] = await db
    .select({
      subject: threads.subject,
      category: threads.category,
      triagedAt: threads.triagedAt,
    })
    .from(threads)
    // Tenant-scoped like every other read a job payload drives.
    .where(and(eq(threads.id, threadId), eq(threads.tenantId, tenantId)))
    .limit(1);

  if (!thread || thread.triagedAt !== null) return null;

  const threadMessages = await db
    .select({
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      bodyText: messages.bodyText,
      snippet: messages.snippet,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    // Oldest first: the mail that opened the thread is what it is about.
    .orderBy(asc(messages.sentAt))
    // The classifier drops anything past this anyway, so the rows are not read.
    .limit(MAX_THREAD_MESSAGES);

  const { category, model } = await classifyThread(client, {
    subject: thread.subject,
    messages: threadMessages,
  });

  const stored = await db
    .update(threads)
    .set({ category, triagedAt: now, updatedAt: now })
    .where(
      and(
        eq(threads.id, threadId),
        eq(threads.tenantId, tenantId),
        // Classifying is a slow call, so two workers can reach here with the
        // same thread. The first one to arrive wins and the other writes
        // nothing, rather than overwriting a category that is already published.
        isNull(threads.triagedAt),
      ),
    )
    .returning({ id: threads.id });

  if (stored.length === 0) return null;

  await recordAuditLogEntry(db, {
    action: "thread_classified",
    tenantId,
    actor: { type: "system" },
    threadId,
    previousCategory: thread.category,
    category,
    model,
    occurredAt: now,
  });

  return { threadId, category, model };
};
