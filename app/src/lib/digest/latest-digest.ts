// El digest diari que llegeix el tauler (context.md §2, §5): l'últim resum que
// el worker ha desat per al tenant. Fora del Server Component perquè la
// consulta es pugui provar sense arrencar Next.

import { desc, eq } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { dailyDigests } from "@correu-agent/shared/db/schema";

export interface LatestDailyDigest {
  /** The UTC day covered, `YYYY-MM-DD`. */
  day: string;
  /** The prose Sonnet wrote for that day (context.md §6). */
  summary: string;
  /** When the digest was last written — a re-run corrects the same day. */
  updatedAt: Date;
}

export interface LatestDailyDigestOptions {
  tenantId: string;
}

/**
 * The most recent digest of a tenant, or null while none has been written.
 *
 * Newest by the day covered, not by when the row was written: correcting an
 * older day (a re-run replaces the digest it covers) must not push that
 * correction above the most recent day the reader came for.
 */
export const latestDailyDigest = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  { tenantId }: LatestDailyDigestOptions,
): Promise<LatestDailyDigest | null> => {
  // `thread_count` is deliberately left unread: the page regroups the day's
  // threads to list them, and a stored count taken before a correction would
  // then contradict the sections printed right under it.
  const [digest] = await db
    .select({
      day: dailyDigests.digestDate,
      summary: dailyDigests.summary,
      updatedAt: dailyDigests.updatedAt,
    })
    .from(dailyDigests)
    .where(eq(dailyDigests.tenantId, tenantId))
    .orderBy(desc(dailyDigests.digestDate))
    .limit(1);

  return digest ?? null;
};
