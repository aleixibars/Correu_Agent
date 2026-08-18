// Aggregating one day of triaged mail for the daily digest (context.md §2, §5).
// The grouping is what both readers need: the model that writes the digest, and
// the dashboard that renders it — so neither has to re-derive it and disagree.

import { and, asc, eq, gte, isNotNull, lt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { threads } from "../db/schema";
import { TRIAGE_CATEGORIES, type TriageCategory } from "../triage/taxonomy";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A digest day is a UTC calendar date, `YYYY-MM-DD`. */
const DIGEST_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The UTC day a moment falls in. Days are UTC rather than local: there is no
 * per-tenant timezone to read (context.md §7), and a digest that followed the
 * server's locale would regroup yesterday's mail the first time Render moved
 * the worker.
 */
export const digestDay = (moment: Date): string =>
  moment.toISOString().slice(0, 10);

/** The day before the given moment — the last day a digest can cover in full. */
export const previousDigestDay = (moment: Date): string =>
  digestDay(new Date(moment.getTime() - DAY_MS));

/** The half-open window `[start, end)` a digest day covers. */
export const digestDayRange = (day: string): { start: Date; end: Date } => {
  const start = new Date(`${day}T00:00:00.000Z`);
  // Round-tripped rather than only pattern-matched: "2026-02-31" is a
  // well-formed date that `Date` silently rolls forward into March, which would
  // digest a day nobody asked for instead of failing.
  if (!DIGEST_DAY_PATTERN.test(day) || digestDay(start) !== day) {
    throw new Error(`A digest day is a UTC calendar date, not "${day}".`);
  }
  return { start, end: new Date(start.getTime() + DAY_MS) };
};

/**
 * One thread as the digest reads it. The subject and the category are the whole
 * of it: no message body is read, so the digest of a day whose mail has since
 * been purged (context.md §7) still says what it said on the day.
 */
export interface DigestThread {
  id: string;
  subject: string | null;
  category: TriageCategory;
  lastMessageAt: Date | null;
}

export interface DigestSection {
  category: TriageCategory;
  threads: DigestThread[];
}

export interface DailyDigestContent {
  /** The UTC day covered, `YYYY-MM-DD`. */
  day: string;
  threadCount: number;
  /** In taxonomy order (context.md §4); a category with no mail is left out. */
  sections: DigestSection[];
}

export interface CollectDailyDigestInput {
  tenantId: string;
  day: string;
}

/**
 * The threads a tenant processed on one day, grouped by category (context.md §2).
 *
 * "Processed" is `triagedAt`, not when the mail arrived: a thread that landed
 * just before midnight and was classified after it belongs to the digest of the
 * day the pipeline actually dealt with it, and the two never both claim it.
 */
export const collectDailyDigest = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, day }: CollectDailyDigestInput,
): Promise<DailyDigestContent> => {
  const { start, end } = digestDayRange(day);

  const rows = await db
    .select({
      id: threads.id,
      subject: threads.subject,
      category: threads.category,
      lastMessageAt: threads.lastMessageAt,
    })
    .from(threads)
    .where(
      and(
        eq(threads.tenantId, tenantId),
        gte(threads.triagedAt, start),
        lt(threads.triagedAt, end),
        // A thread is stamped and categorised in the same write, so this only
        // narrows the column's type — the digest never shows an empty category.
        isNotNull(threads.category),
      ),
    )
    // Oldest first inside a category, and by id where two threads share a
    // moment, so a regenerated digest reads in the same order as the first one.
    .orderBy(asc(threads.lastMessageAt), asc(threads.id));

  const byCategory = new Map<TriageCategory, DigestThread[]>();
  for (const row of rows) {
    const category = row.category as TriageCategory;
    const thread: DigestThread = { ...row, category };
    const existing = byCategory.get(category);
    if (existing) existing.push(thread);
    else byCategory.set(category, [thread]);
  }

  // Iterating the taxonomy rather than the map: the dashboard reads urgent
  // first and the catch-all last, whatever order the rows came back in.
  const sections = TRIAGE_CATEGORIES.flatMap((category) => {
    const threadsInCategory = byCategory.get(category);
    return threadsInCategory ? [{ category, threads: threadsInCategory }] : [];
  });

  return { day, threadCount: rows.length, sections };
};
