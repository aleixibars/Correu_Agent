import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { APP_NAME } from "@correu-agent/shared";
import { POLL_INTERVAL_MS } from "./poll-interval";
import {
  loadMicrosoftPollConfig,
  type MicrosoftPollConfig,
} from "./poll/microsoft";
import { startMailboxPollSchedule } from "./poll/schedule";
import { createMailboxPollHandler } from "./queue/mailbox-poll";
import { createQueueClient, startQueue } from "./queue/queue-client";

// Entry point for the polling worker (context.md §10): a 2-minute schedule that
// queues one job per connected mailbox, and the queue workers that poll them.

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

// Read at boot, not per poll: a missing Entra secret should stop the worker
// rather than fail one mailbox at a time, two minutes apart, forever.
const microsoft: MicrosoftPollConfig = loadMicrosoftPollConfig();

const db = drizzle(new Pool({ connectionString: databaseUrl }));
const boss = createQueueClient(databaseUrl);

boss.on("error", (error) => {
  console.error("Queue error:", error);
});

await startQueue(boss, createMailboxPollHandler({ db, microsoft }));
const schedule = startMailboxPollSchedule({ boss, db });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`Received ${signal}, stopping worker.`);
  schedule.stop();
  try {
    // Lets in-flight jobs finish instead of leaving them stuck in `active`.
    await boss.stop();
    process.exit(0);
  } catch (error) {
    console.error("Failed to stop the queue cleanly:", error);
    process.exit(1);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `${APP_NAME} worker started. Polling connected mailboxes every ${POLL_INTERVAL_MS}ms.`,
);
