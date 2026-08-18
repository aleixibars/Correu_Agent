// Retention (context.md §7): the full body of a mail is kept for 90 days, then
// replaced by a schematic version — metadata, the thread's category and a
// summary. The row itself stays: the audit trail and the digest still point at
// it, so deleting it would leave both with a dangling reference.

import { and, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { messages } from "../db/schema";

/** How long the full body is kept (context.md §7); per-tenant retention is future work. */
export const RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much of the body is kept as the summary of a message that never got a
 * snippet from its provider — long enough to recognise the mail, short enough
 * not to be the body under another name.
 */
export const PURGED_SUMMARY_LENGTH = 200;

/** Mail sent before this moment has outlived the retention window. */
export const retentionCutoff = (now: Date): Date =>
  new Date(now.getTime() - RETENTION_DAYS * DAY_MS);

/** A message whose body this purge dropped. */
export interface PurgedMessageBody {
  id: string;
  tenantId: string;
  threadId: string;
}

export interface PurgeExpiredMessageBodiesOptions {
  /** The moment the window is measured back from; defaults to the wall clock. */
  now?: Date;
}

/**
 * Purges the body of every message past the retention window and reports the
 * ones it emptied.
 *
 * Idempotent: `bodyPurgedAt` is both the stamp and the guard, so a purge that
 * ran yesterday costs nothing today and a job retried after a crash cannot
 * re-purge — nor overwrite the summary it already saved.
 */
export const purgeExpiredMessageBodies = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { now = new Date() }: PurgeExpiredMessageBodiesOptions = {},
): Promise<PurgedMessageBody[]> =>
  db
    .update(messages)
    .set({
      bodyText: null,
      bodyHtml: null,
      // Postgres evaluates a SET expression against the *old* row, so the body
      // is still readable here: mail the provider gave no snippet for keeps the
      // head of its body as the summary that survives the purge.
      snippet: sql`coalesce(${messages.snippet}, left(${messages.bodyText}, ${PURGED_SUMMARY_LENGTH}))`,
      bodyPurgedAt: now,
    })
    .where(
      and(
        // Mail is aged by the date the provider gave it; a message stored
        // without one falls back to when it was written, so nothing can sit
        // outside the window forever.
        // As an ISO string, like the timestamp columns themselves are bound:
        // the driver must not be left to read a `Date` in its local timezone.
        sql`coalesce(${messages.sentAt}, ${messages.createdAt}) < ${retentionCutoff(now).toISOString()}`,
        isNull(messages.bodyPurgedAt),
      ),
    )
    .returning({
      id: messages.id,
      tenantId: messages.tenantId,
      threadId: messages.threadId,
    });
