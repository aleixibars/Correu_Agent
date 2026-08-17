// Polling cadence for connected mailboxes (context.md §8): every 2 minutes,
// until the migration to Gmail Pub/Sub / Microsoft Graph webhooks.

export const POLL_INTERVAL_MS = 2 * 60 * 1000;
