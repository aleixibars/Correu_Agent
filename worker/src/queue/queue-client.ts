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
 * `createQueue()` does nothing when the queue already exists and pg-boss refuses
 * to change a policy afterwards, so a queue first created by an earlier worker
 * keeps whatever policy it was born with — silently, and the de-duplication
 * above would never apply. The queue holds nothing worth keeping (a lost tick
 * only means polling two minutes later), so a wrong policy is fixed by
 * recreating the queue rather than left to rot.
 */
const ensurePollQueue = async (boss: PgBoss, name: string): Promise<void> => {
  await boss.createQueue(name, { policy: MAILBOX_POLL_QUEUE_POLICY });

  const queue = await boss.getQueue(name);
  if (!queue || queue.policy === MAILBOX_POLL_QUEUE_POLICY) return;

  console.warn(
    `Queue "${name}" exists with policy "${queue.policy}"; recreating it as "${MAILBOX_POLL_QUEUE_POLICY}".`,
  );
  await boss.deleteQueue(name);
  await boss.createQueue(name, { policy: MAILBOX_POLL_QUEUE_POLICY });
};

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
  await ensurePollQueue(boss, MAILBOX_POLL_QUEUE);

  await boss.work<MailboxPollJobData, MailboxPollResult>(
    MAILBOX_POLL_QUEUE,
    handleMailboxPoll,
  );
};
