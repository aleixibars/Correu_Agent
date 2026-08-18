import { PgBoss, type WorkHandler } from "pg-boss";
import {
  MAILBOX_POLL_QUEUE,
  type MailboxPollJobData,
  type MailboxPollResult,
} from "./mailbox-poll";

/**
 * pg-boss keeps its own tables in a dedicated schema of the same Neon database
 * the app uses (context.md §10) — no extra infrastructure for the PoC queue.
 */
export const QUEUE_SCHEMA = "pgboss";

/**
 * `singletonKey` is inert on the default `standard` policy: pg-boss only
 * enforces it through the partial index a non-standard policy creates. Without
 * this, every 2-minute tick would stack another poll job behind a slow one.
 * `short` allows one *queued* job per mailbox while its poll is active, which
 * is exactly one pending re-poll and never a backlog.
 */
export const MAILBOX_POLL_QUEUE_POLICY = "short";

export const createQueueClient = (connectionString: string): PgBoss =>
  new PgBoss({ connectionString, schema: QUEUE_SCHEMA });

/**
 * Connects to Postgres, makes sure the `mailbox-poll` queue exists and starts
 * consuming it with the given handler. pg-boss creates/migrates its own schema
 * on `start()`.
 */
export const startQueue = async (
  boss: PgBoss,
  handleMailboxPoll: WorkHandler<MailboxPollJobData, MailboxPollResult>,
): Promise<void> => {
  await boss.start();
  await boss.createQueue(MAILBOX_POLL_QUEUE, {
    policy: MAILBOX_POLL_QUEUE_POLICY,
  });

  // createQueue does nothing to a queue that already exists, and pg-boss
  // refuses to change a policy afterwards — a queue created by an older worker
  // would keep stacking duplicate polls in silence, so say so out loud.
  const queue = await boss.getQueue(MAILBOX_POLL_QUEUE);
  if (queue && queue.policy !== MAILBOX_POLL_QUEUE_POLICY) {
    console.warn(
      `Queue "${MAILBOX_POLL_QUEUE}" has policy "${queue.policy}", not "${MAILBOX_POLL_QUEUE_POLICY}": duplicate poll jobs can pile up. Delete the queue once so it is recreated.`,
    );
  }

  await boss.work<MailboxPollJobData, MailboxPollResult>(
    MAILBOX_POLL_QUEUE,
    handleMailboxPoll,
  );
};
