import { PgBoss, type WorkHandler } from "pg-boss";
import {
  MAILBOX_POLL_QUEUE,
  type MailboxPollJobData,
  type MailboxPollResult,
} from "./mailbox-poll";
import {
  THREAD_TRIAGE_QUEUE,
  type ThreadTriageJobData,
  type ThreadTriageResult,
} from "./thread-triage";

/**
 * pg-boss keeps its own tables in a dedicated schema of the same Neon database
 * the app uses (context.md §10) — no extra infrastructure for the PoC queue.
 */
export const QUEUE_SCHEMA = "pgboss";

/**
 * `singletonKey` is inert on the default `standard` policy: pg-boss only
 * enforces it through the partial index a non-standard policy creates. Without
 * this, every 2-minute tick would stack another job behind a slow one — another
 * poll per mailbox, another classification per thread.
 * `short` allows one *queued* job per key while its work is active, which is
 * exactly one pending repeat and never a backlog.
 */
export const QUEUE_POLICY = "short";

export const createQueueClient = (connectionString: string): PgBoss =>
  new PgBoss({ connectionString, schema: QUEUE_SCHEMA });

/**
 * `createQueue()` does nothing when the queue already exists and pg-boss refuses
 * to change a policy afterwards, so a queue first created by an earlier worker
 * keeps whatever policy it was born with — silently, and the de-duplication
 * above would never apply. The queue holds nothing worth keeping (a lost tick
 * only means polling or triaging two minutes later), so a wrong policy is fixed
 * by recreating the queue rather than left to rot.
 */
const ensureQueue = async (boss: PgBoss, name: string): Promise<void> => {
  await boss.createQueue(name, { policy: QUEUE_POLICY });

  const queue = await boss.getQueue(name);
  if (!queue || queue.policy === QUEUE_POLICY) return;

  console.warn(
    `Queue "${name}" exists with policy "${queue.policy}"; recreating it as "${QUEUE_POLICY}".`,
  );
  await boss.deleteQueue(name);
  await boss.createQueue(name, { policy: QUEUE_POLICY });
};

export interface QueueHandlers {
  mailboxPoll: WorkHandler<MailboxPollJobData, MailboxPollResult>;
  threadTriage: WorkHandler<ThreadTriageJobData, ThreadTriageResult>;
}

/**
 * Connects to Postgres, makes sure both pipeline queues exist and starts
 * consuming them. pg-boss creates/migrates its own schema on `start()`.
 */
export const startQueue = async (
  boss: PgBoss,
  { mailboxPoll, threadTriage }: QueueHandlers,
): Promise<void> => {
  await boss.start();

  await ensureQueue(boss, MAILBOX_POLL_QUEUE);
  await boss.work<MailboxPollJobData, MailboxPollResult>(
    MAILBOX_POLL_QUEUE,
    mailboxPoll,
  );

  await ensureQueue(boss, THREAD_TRIAGE_QUEUE);
  await boss.work<ThreadTriageJobData, ThreadTriageResult>(
    THREAD_TRIAGE_QUEUE,
    threadTriage,
  );
};
