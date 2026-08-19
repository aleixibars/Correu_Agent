import { createServer } from "node:http";
import { APP_NAME } from "@correu-agent/shared";
import { createAnthropicClient } from "@correu-agent/shared/triage";
import {
  createWebPushSender,
  loadVapidConfig,
} from "@correu-agent/shared/web-push";
import { createDatabase } from "./db";
import { createThreadAutoReplySender } from "./drafts/auto-reply";
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
import { createDailyDigestHandler } from "./queue/daily-digest";
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
// workers that poll, classify and answer them, the daily 90-day retention purge
// (context.md §7) and the daily digest (context.md §2).
//
// Deployed as a free Render Web Service rather than a paid Background Worker
// (context.md §10): Render requires every Web Service to bind $PORT and
// answer HTTP, so this listens purely to satisfy that health check — an
// external pinger (e.g. cron-job.org) hits it every ~10 minutes to keep the
// free tier from spinning down after 15 minutes idle, since a sleeping
// worker stops polling mailboxes until something wakes it.

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

// Read at boot, not per poll: a missing Google, Entra, Anthropic or VAPID secret
// should stop the worker rather than fail one mailbox at a time, two minutes
// apart, forever.
const google: GmailPollConfig = loadGmailPollConfig();
const microsoft: MicrosoftPollConfig = loadMicrosoftPollConfig();
const anthropic = createAnthropicClient();
const webPush = createWebPushSender(loadVapidConfig(process.env));

const db = createDatabase(databaseUrl);
const boss = createQueueClient(databaseUrl);

boss.on("error", (error) => {
  console.error("Queue error:", error);
});

// A ping only proves the process is alive, not that the queue is healthy —
// this endpoint exists for Render's port check, not as a real health probe.
const port = Number(process.env.PORT ?? 3001);
const healthServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});
healthServer.listen(port, () => {
  console.log(`Health check listening on :${port}.`);
});

// Assigned once the queue is up; the shutdown handler is registered before that
// and has to cope with a signal arriving in between.
let pollSchedule: MailboxPollSchedule | undefined;
let triageSchedule: ThreadTriageSchedule | undefined;
let draftSchedule: ThreadDraftSchedule | undefined;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`Received ${signal}, stopping worker.`);
  healthServer.close();
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
  threadTriage: createThreadTriageHandler({
    db,
    anthropic: anthropic.messages,
    webPush,
  }),
  threadDraft: createThreadDraftHandler({
    db,
    anthropic: anthropic.messages,
    // Mail that leaves without anyone approving it, for the categories whose
    // rule is on (context.md §2).
    autoReply: createThreadAutoReplySender({ db, google, microsoft }),
  }),
  retentionPurge: createRetentionPurgeHandler({ db }),
  dailyDigest: createDailyDigestHandler({ db, anthropic: anthropic.messages }),
});
pollSchedule = startMailboxPollSchedule({ boss, db });
triageSchedule = startThreadTriageSchedule({ boss, db });
draftSchedule = startThreadDraftSchedule({ boss, db });

console.log(
  `${APP_NAME} worker started. Polling connected mailboxes, triaging new threads and drafting replies every ${POLL_INTERVAL_MS}ms.`,
);
