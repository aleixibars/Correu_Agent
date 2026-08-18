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
 * `short` keeps at most one job queued per key: a mailbox whose poll is still
 * waiting, or a tick that arrives while the worker is behind, replaces nothing
 * and queues nothing — the next cadence covers it anyway.
 */
const QUEUE_POLICY = "short";

/**
 * `createQueue()` does nothing when the queue already exists and `updateQueue()`
 * refuses to change a policy, so a queue first created by an earlier worker keeps
 * whatever policy it was born with — silently, and the de-duplication below would
 * never apply. Neither of these queues holds anything worth keeping (a lost tick
 * only means polling two minutes later), so a wrong policy is fixed by recreating
 * the queue rather than left to rot.
 */
const ensurePollQueue = async (boss: PgBoss, name: string): Promise<void> => {
  await boss.createQueue(name, { policy: QUEUE_POLICY });

  const [queue] = await boss.getQueues([name]);
  if (!queue || queue.policy === QUEUE_POLICY) return;

  console.warn(
    `Queue "${name}" exists with policy "${queue.policy}"; recreating it as "${QUEUE_POLICY}".`,
  );
  await boss.deleteQueue(name);
  await boss.createQueue(name, { policy: QUEUE_POLICY });
};

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
  await ensurePollQueue(boss, MAILBOX_POLL_QUEUE);
  await ensurePollQueue(boss, MAILBOX_POLL_DISPATCH_QUEUE);

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
