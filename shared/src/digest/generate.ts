// Producing one tenant's daily digest (context.md §2): aggregate the day, ask
// Sonnet to write it, store it for the dashboard to read. Nothing is mailed —
// the digest lives inside the dashboard (context.md §5).

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { dailyDigests } from "../db/schema";
import { collectDailyDigest } from "./collect";
import {
  summariseDailyDigest,
  type DigestMessagesClient,
  type DigestSummary,
} from "./summarise";

export interface GenerateDailyDigestInput {
  tenantId: string;
  /** The UTC day to digest, `YYYY-MM-DD`. */
  day: string;
  /** Stamp for the write; defaults to the wall clock. */
  now?: Date;
}

export type GeneratedDailyDigest = DigestSummary & {
  tenantId: string;
  day: string;
  threadCount: number;
};

/**
 * Writes the digest of one day for one tenant, or answers `null` when the day
 * processed no mail — a heading over nothing helps nobody, and the model call
 * it would take is the expensive half of this job.
 *
 * Re-running a day replaces its digest: the threads it covers are fixed once
 * they are triaged, so a second run is a correction, never a second digest.
 */
export const generateDailyDigest = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  client: DigestMessagesClient,
  { tenantId, day, now = new Date() }: GenerateDailyDigestInput,
): Promise<GeneratedDailyDigest | null> => {
  const content = await collectDailyDigest(db, { tenantId, day });

  if (content.threadCount === 0) return null;

  const { summary, model } = await summariseDailyDigest(client, content);

  await db
    .insert(dailyDigests)
    .values({
      tenantId,
      digestDate: day,
      summary,
      threadCount: content.threadCount,
      model,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [dailyDigests.tenantId, dailyDigests.digestDate],
      set: {
        summary,
        threadCount: content.threadCount,
        model,
        updatedAt: now,
      },
    });

  return { tenantId, day, threadCount: content.threadCount, summary, model };
};
