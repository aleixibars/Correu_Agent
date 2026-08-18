import { APP_NAME } from "@correu-agent/shared";
import { loadGoogleOAuthCredentials } from "@correu-agent/shared/mail";
import { loadTokenEncryptionKey } from "@correu-agent/shared/token-encryption";
import { createDatabase } from "./db";
import { POLL_CRON_EXPRESSION } from "./poll-interval";
import { MAILBOX_POLL_QUEUE } from "./queue/mailbox-poll";
import { createQueueClient, startQueue } from "./queue/queue-client";

// Entry point for the polling worker (context.md §10). Every 2 minutes it fans
// out one poll job per connected Gmail mailbox; persisting the mail it finds
// and triaging it land in the issues that follow.

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

// Checked at boot rather than on the first poll: nobody is watching a background
// worker, so a missing key would otherwise only show up as every poll job failing
// silently every two minutes.
loadTokenEncryptionKey();
loadGoogleOAuthCredentials();

const boss = createQueueClient(databaseUrl);
const db = createDatabase(databaseUrl);

boss.on("error", (error) => {
  console.error("Queue error:", error);
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`Received ${signal}, stopping worker.`);
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

await startQueue(boss, db);

console.log(
  `${APP_NAME} worker started. Consuming "${MAILBOX_POLL_QUEUE}", polling on "${POLL_CRON_EXPRESSION}".`,
);
