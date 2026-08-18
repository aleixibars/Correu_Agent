import { PgBoss } from "pg-boss";
import type { Database } from "../db";
import {
  listGmailPollTargets,
  pollGmailMailbox,
} from "../mailbox/gmail-poll";
import { POLL_CRON_EXPRESSION } from "../poll-interval";
import {
  MAILBOX_POLL_QUEUE,
  createMailboxPollHandler,
  type MailboxPollJobData,
  type MailboxPollResult,
} from "./mailbox-poll";
import {
  MAILBOX_POLL_DISPATCH_QUEUE,
  createMailboxPollDispatchHandler,
  type MailboxPollDispatchResult,
} from "./mailbox-poll-dispatch";

/**
 * pg-boss keeps its own tables in a dedicated schema of the same Neon database
 * the app uses (context.md §10) — no extra infrastructure for the PoC queue.
 */
export const QUEUE_SCHEMA = "pgboss";

export const createQueueClient = (connectionString: string): PgBoss =>
  new PgBoss({ connectionString, schema: QUEUE_SCHEMA });

/**
 * Connects to Postgres, makes sure both polling queues exist, starts consuming
 * them and puts the fan-out on the 2-minute schedule (context.md §8). pg-boss
 * creates/migrates its own schema on `start()`.
 */
export const startQueue = async (
  boss: PgBoss,
  db: Database,
): Promise<void> => {
  await boss.start();
  // `short` keeps at most one job queued per key: a mailbox whose poll is still
  // waiting, or a tick that arrives while the worker is behind, replaces
  // nothing and queues nothing — the next cadence covers it anyway.
  await boss.createQueue(MAILBOX_POLL_QUEUE, { policy: "short" });
  await boss.createQueue(MAILBOX_POLL_DISPATCH_QUEUE, { policy: "short" });

  await boss.work<MailboxPollJobData, MailboxPollResult>(
    MAILBOX_POLL_QUEUE,
    createMailboxPollHandler({
      pollGmailMailbox: (target) => pollGmailMailbox(db, target),
    }),
  );

  await boss.work<object, MailboxPollDispatchResult>(
    MAILBOX_POLL_DISPATCH_QUEUE,
    createMailboxPollDispatchHandler({
      listPollTargets: () => listGmailPollTargets(db),
      queuePoll: async (target) => {
        // The key is what makes the queue's `short` policy per mailbox rather
        // than per queue: one mailbox waiting must not block the others.
        await boss.send(MAILBOX_POLL_QUEUE, target, {
          singletonKey: target.mailboxAccountId,
        });
      },
    }),
  );

  // The schedule is upserted by name, so restarting the worker does not stack
  // up duplicate cron entries.
  await boss.schedule(MAILBOX_POLL_DISPATCH_QUEUE, POLL_CRON_EXPRESSION);
};
