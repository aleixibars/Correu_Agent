import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { WorkHandler } from "pg-boss";
import { tenants } from "@correu-agent/shared/db/schema";
import {
  generateDailyDigest,
  previousDigestDay,
  type DigestMessagesClient,
  type GeneratedDailyDigest,
} from "@correu-agent/shared/digest";

/** Queue that writes the daily digest shown in the dashboard (context.md §2, §5). */
export const DAILY_DIGEST_QUEUE = "daily-digest";

/**
 * Once a day, at 05:00 UTC: the digest covers a whole calendar day, so it can
 * only run after that day has ended, and an hour of slack past midnight keeps a
 * thread triaged at 23:59 from being missed by the run that reports it. pg-boss
 * owns the cron, so a redeploy does not restart the clock and two workers do not
 * both fire it.
 */
export const DAILY_DIGEST_CRON = "0 5 * * *";

/**
 * Retries spread over hours instead of pg-boss's default (2 retries, no delay).
 *
 * A day is digested by exactly one run: nothing revisits a day whose run failed,
 * so three attempts fired within the same second are no defence at all against
 * the failure this job actually meets — an overloaded model API, or a key that
 * needs rotating — and the day would be lost for good. Backing off buys the
 * hours those take to clear.
 *
 * The delays stay well inside the day being digested: 05:00 UTC plus a worst
 * case of roughly four hours of backoff is still the same UTC day, so a retry
 * never crosses midnight and re-aims at the day after the one it was queued for.
 */
export const DAILY_DIGEST_RETRY = {
  retryLimit: 4,
  retryDelay: 900,
  retryBackoff: true,
} as const;

/** The digest takes no arguments: it is yesterday, for every tenant. */
export type DailyDigestJobData = Record<string, never>;

export type FailedTenantDigest = { tenantId: string; error: string };

export type DailyDigestResult = {
  /** The UTC day digested, `YYYY-MM-DD`. */
  day: string;
  generated: GeneratedDailyDigest[];
  /** Tenants whose day processed no mail, so there was nothing to digest. */
  skipped: string[];
  failed: FailedTenantDigest[];
};

export interface DailyDigestDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
  anthropic: DigestMessagesClient;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Writes every tenant's digest of the day that just ended (context.md §2).
 *
 * Every tenant is asked rather than only those with mail: the read that decides
 * is the same grouped read the digest is built from, and a quiet tenant costs
 * that one query and no model call.
 */
export const createDailyDigestHandler = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  db,
  anthropic,
}: DailyDigestDeps<T, TSchema>): WorkHandler<
  DailyDigestJobData,
  DailyDigestResult
> => {
  // The jobs carry no payload, so ticks that piled up behind a slow run all
  // describe the same day: the batch is one pass, not one pass per job.
  return async () => {
    const day = previousDigestDay(new Date());
    const rows = await db.select({ id: tenants.id }).from(tenants);

    const generated: GeneratedDailyDigest[] = [];
    const skipped: string[] = [];
    const failed: FailedTenantDigest[] = [];

    // One tenant at a time: a tenant the model choked on must not take the
    // others' digests with it.
    for (const { id: tenantId } of rows) {
      try {
        const digest = await generateDailyDigest(db, anthropic, {
          tenantId,
          day,
        });
        if (digest) generated.push(digest);
        else skipped.push(tenantId);
      } catch (error) {
        console.error(`Digesting ${day} for tenant ${tenantId} failed:`, error);
        failed.push({ tenantId, error: errorMessage(error) });
      }
    }

    // A run where everything failed is worth retrying: reporting success would
    // hide, say, an expired API key behind an empty result once a day, forever.
    if (generated.length === 0 && skipped.length === 0 && failed.length > 0) {
      throw new Error(
        `Every tenant failed to digest ${day}: ${failed
          .map(({ error }) => error)
          .join("; ")}`,
      );
    }

    return { day, generated, skipped, failed };
  };
};
