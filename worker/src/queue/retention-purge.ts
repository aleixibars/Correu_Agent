import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { WorkHandler } from "pg-boss";
import {
  RETENTION_DAYS,
  purgeExpiredMessageBodies,
} from "@correu-agent/shared/retention";

/** Queue that runs the 90-day body purge (context.md §7). */
export const RETENTION_PURGE_QUEUE = "retention-purge";

/**
 * Once a day, at 03:00 UTC: the window is measured in days, so anything more
 * frequent only rewrites the same rows, and the small hours keep the purge off
 * the polling worker's busy time. pg-boss owns the cron, so a restart does not
 * re-run it and two workers do not both fire it.
 */
export const RETENTION_PURGE_CRON = "0 3 * * *";

/** The purge takes no arguments: it is the whole database's expired mail. */
export type RetentionPurgeJobData = Record<string, never>;

export type RetentionPurgeResult = {
  /** How many message bodies this run emptied. */
  purged: number;
};

export interface RetentionPurgeDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
}

/**
 * Replaces the body of every message past the retention window with its
 * schematic version — metadata, the thread's category and a summary
 * (context.md §7).
 */
export const createRetentionPurgeHandler = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  db,
}: RetentionPurgeDeps<T, TSchema>): WorkHandler<
  RetentionPurgeJobData,
  RetentionPurgeResult
> => {
  // One statement covers the whole batch: the jobs carry no payload, so ticks
  // that piled up behind a slow purge describe the same work.
  return async () => {
    const purged = await purgeExpiredMessageBodies(db);

    if (purged > 0) {
      console.log(
        `Purged the body of ${purged} message(s) older than ${RETENTION_DAYS} days.`,
      );
    }

    return { purged };
  };
};
