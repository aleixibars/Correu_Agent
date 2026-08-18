import { APP_NAME } from "@correu-agent/shared";
import { createAnthropicClient } from "@correu-agent/shared/triage";
import { createDatabase } from "./db";
import {
  startThreadDraftSchedule,
  type ThreadDraftSchedule,
} from "./drafts/schedule";
import { POLL_INTERVAL_MS } from "./poll-interval";
import { loadGmailPollConfig, type GmailPollConfig } from "./poll/gmail";
import {
  loadMicrosoftPollConfig,
  type MicrosoftPollConfig,
} from "./poll/microsoft";
import {
  startMailboxPollSchedule,
  type MailboxPollSchedule,
} from "./poll/schedule";
import { createMailboxPollHandler } from "./queue/mailbox-poll";
import { createQueueClient, startQueue } from "./queue/queue-client";
import { createRetentionPurgeHandler } from "./queue/retention-purge";
import { createThreadDraftHandler } from "./queue/thread-draft";
import { createThreadTriageHandler } from "./queue/thread-triage";
import {
  startThreadTriageSchedule,
  type ThreadTriageSchedule,
} from "./triage/schedule";

// Entry point for the pipeline worker (context.md §10): a 2-minute schedule that
// queues one job per connected mailbox, one per thread still waiting for a
// category and one per triaged thread still waiting for a reply draft, the queue
// workers that poll, classify and answer them, and the daily 90-day retention
// purge (context.md §7).

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

// Read at boot, not per poll: a missing Google, Entra or Anthropic secret should
// stop the worker rather than fail one mailbox at a time, two minutes apart,
// forever.
const google: GmailPollConfig = loadGmailPollConfig();
const microsoft: MicrosoftPollConfig = loadMicrosoftPollConfig();
const anthropic = createAnthropicClient();

const db = createDatabase(databaseUrl);
const boss = createQueueClient(databaseUrl);

boss.on("error", (error) => {
  console.error("Queue error:", error);
});

// Assigned once the queue is up; the shutdown handler is registered before that
// and has to cope with a signal arriving in between.
let pollSchedule: MailboxPollSchedule | undefined;
let triageSchedule: ThreadTriageSchedule | undefined;
let draftSchedule: ThreadDraftSchedule | undefined;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`Received ${signal}, stopping worker.`);
  pollSchedule?.stop();
  triageSchedule?.stop();
  draftSchedule?.stop();
  try {
    // Lets in-flight jobs finish instead of leaving them stuck in `active`.
    await boss.stop();
    process.exit(0);
  } catch (error) {
    console.error("Failed to stop the queue cleanly:", error);
    process.exit(1);
  }
};

// Registered before start() so a signal arriving during the pg-boss schema
// migration still shuts the worker down: stop() waits for an in-flight start().
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await startQueue(boss, {
  mailboxPoll: createMailboxPollHandler({ db, google, microsoft }),
  threadTriage: createThreadTriageHandler({ db, anthropic: anthropic.messages }),
  threadDraft: createThreadDraftHandler({ db, anthropic: anthropic.messages }),
  retentionPurge: createRetentionPurgeHandler({ db }),
});
pollSchedule = startMailboxPollSchedule({ boss, db });
triageSchedule = startThreadTriageSchedule({ boss, db });
draftSchedule = startThreadDraftSchedule({ boss, db });

console.log(
  `${APP_NAME} worker started. Polling connected mailboxes, triaging new threads and drafting replies every ${POLL_INTERVAL_MS}ms.`,
);
