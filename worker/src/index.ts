import { APP_NAME } from "@correu-agent/shared";
import { POLL_INTERVAL_MS } from "./poll-interval";
import { MAILBOX_POLL_QUEUE } from "./queue/mailbox-poll";
import { createQueueClient, startQueue } from "./queue/queue-client";

// Entry point for the polling worker (context.md §10). The mailbox polling loop
// and the provider clients (Gmail API / Microsoft Graph) land here issue by
// issue — for now the worker only boots the pg-boss queue.

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

const boss = createQueueClient(databaseUrl);

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

await startQueue(boss);

console.log(
  `${APP_NAME} worker started. Consuming "${MAILBOX_POLL_QUEUE}", poll interval: ${POLL_INTERVAL_MS}ms.`,
);
