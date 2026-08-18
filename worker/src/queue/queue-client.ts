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
  await boss.createQueue(MAILBOX_POLL_QUEUE);
  await boss.work<MailboxPollJobData, MailboxPollResult>(
    MAILBOX_POLL_QUEUE,
    handleMailboxPoll,
  );
};
