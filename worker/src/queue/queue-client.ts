import { PgBoss, type WorkHandler } from "pg-boss";
import {
  MAILBOX_POLL_QUEUE,
  type MailboxPollJobData,
  type MailboxPollResult,
} from "./mailbox-poll";
import {
  RETENTION_PURGE_CRON,
  RETENTION_PURGE_QUEUE,
  type RetentionPurgeJobData,
  type RetentionPurgeResult,
} from "./retention-purge";
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
 * this, every tick would stack another job behind a slow one — another poll per
 * mailbox, another classification per thread. `short` allows one *queued* job
 * per key while its job is active, which is exactly one pending repeat and never
 * a backlog — the right shape for a mailbox poll, a thread triage and the daily
 * retention purge alike, whose work is the same whether it is queued once or ten
 * times.
 */
export const SINGLE_FLIGHT_QUEUE_POLICY = "short";

export const createQueueClient = (connectionString: string): PgBoss =>
  new PgBoss({ connectionString, schema: QUEUE_SCHEMA });

/**
 * `createQueue()` does nothing when the queue already exists and pg-boss refuses
 * to change a policy afterwards, so a queue first created by an earlier worker
 * keeps whatever policy it was born with — silently, and the de-duplication
 * above would never apply. These queues hold nothing worth keeping (a lost tick
 * only means polling or triaging two minutes later, or purging tomorrow), so a
 * wrong policy is fixed by recreating the queue rather than left to rot.
 */
const ensureQueue = async (boss: PgBoss, name: string): Promise<void> => {
  await boss.createQueue(name, { policy: SINGLE_FLIGHT_QUEUE_POLICY });

  const queue = await boss.getQueue(name);
  if (!queue || queue.policy === SINGLE_FLIGHT_QUEUE_POLICY) return;

  console.warn(
    `Queue "${name}" exists with policy "${queue.policy}"; recreating it as "${SINGLE_FLIGHT_QUEUE_POLICY}".`,
  );
  await boss.deleteQueue(name);
  await boss.createQueue(name, { policy: SINGLE_FLIGHT_QUEUE_POLICY });
};

export interface QueueHandlers {
  mailboxPoll: WorkHandler<MailboxPollJobData, MailboxPollResult>;
  threadTriage: WorkHandler<ThreadTriageJobData, ThreadTriageResult>;
  retentionPurge: WorkHandler<RetentionPurgeJobData, RetentionPurgeResult>;
}

/**
 * Connects to Postgres, makes sure the worker's queues exist and starts
 * consuming them. pg-boss creates/migrates its own schema on `start()`.
 *
 * The mailbox poll and the thread triage are driven from the worker's own
 * 2-minute tick, while the retention purge rides pg-boss's cron: a daily job
 * must not restart its clock every time the worker is redeployed, and must fire
 * once for the cluster rather than once per instance.
 */
export const startQueue = async (
  boss: PgBoss,
  { mailboxPoll, threadTriage, retentionPurge }: QueueHandlers,
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

  await ensureQueue(boss, RETENTION_PURGE_QUEUE);
  // Upserted by name, so changing the cron above is enough to move the schedule.
  await boss.schedule(
    RETENTION_PURGE_QUEUE,
    RETENTION_PURGE_CRON,
    {},
    { singletonKey: RETENTION_PURGE_QUEUE },
  );
  await boss.work<RetentionPurgeJobData, RetentionPurgeResult>(
    RETENTION_PURGE_QUEUE,
    retentionPurge,
  );
};
