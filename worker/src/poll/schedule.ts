// The 2-minute cadence itself (context.md §8): every tick queues one poll job
// per connected mailbox, and the queue workers do the polling.

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgBoss } from "pg-boss";
import { POLL_INTERVAL_MS } from "../poll-interval";
import { MAILBOX_POLL_QUEUE, type MailboxPollJobData } from "../queue/mailbox-poll";
import { listPollableMailboxAccounts } from "./accounts";

export const queueMailboxPolls = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  boss: PgBoss,
  db: PgDatabase<T, TSchema>,
): Promise<number> => {
  const accounts = await listPollableMailboxAccounts(db);

  for (const account of accounts) {
    const data: MailboxPollJobData = {
      tenantId: account.tenantId,
      mailboxAccountId: account.id,
    };
    await boss.send(MAILBOX_POLL_QUEUE, data, {
      // A poll that outlives its tick (a big first sync, a slow Graph) must not
      // leave a queue of duplicate polls waiting behind it.
      singletonKey: `${account.tenantId}:${account.id}`,
    });
  }

  return accounts.length;
};

export interface MailboxPollSchedule {
  stop: () => void;
}

export interface MailboxPollScheduleDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  boss: PgBoss;
  db: PgDatabase<T, TSchema>;
  onError?: (error: unknown) => void;
}

/**
 * Starts the polling cadence and returns a handle to stop it. A tick that fails
 * (Neon dropping a connection, say) is reported and the next one still runs —
 * ending the loop would leave the mailbox unwatched until the worker restarts.
 */
export const startMailboxPollSchedule = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  boss,
  db,
  onError = (error) => console.error("Mailbox poll scheduling failed:", error),
}: MailboxPollScheduleDeps<T, TSchema>): MailboxPollSchedule => {
  const tick = (): void => {
    queueMailboxPolls(boss, db).catch(onError);
  };

  // A worker that just restarted should not wait two minutes to look at the mail.
  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
};
