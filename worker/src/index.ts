import { APP_NAME } from "@correu-agent/shared";
import { POLL_INTERVAL_MS } from "./poll-interval";

// Entry point for the polling worker (context.md §10). The actual mailbox
// polling loop, pg-boss queue wiring, and provider clients (Gmail API /
// Microsoft Graph) land here issue by issue — this is the bootstrap stub.
console.log(`${APP_NAME} worker starting. Poll interval: ${POLL_INTERVAL_MS}ms.`);
