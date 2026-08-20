// What the dashboard home leads with (context.md §2): threads that still need
// something from the reviewer, so the initial screen answers "what's waiting
// for me" without a click into /fils.

import type { ThreadListItem } from "./list-threads";

/** How many threads the home page shows before pointing to the full list. */
export const DEFAULT_ACTIONABLE_THREAD_LIMIT = 10;

const CLOSED_STATUSES = new Set(["replied", "draft-discarded"]);

const needsReviewer = (status: ThreadListItem["status"]): boolean =>
  status === "awaiting-triage" || status === "draft-pending";

/**
 * Threads waiting on the reviewer, plus urgent threads that have not been
 * closed out yet — even once triaged and drafted, urgent mail stays visible
 * until it is replied to or its draft discarded.
 */
export const actionableThreads = (
  threads: ThreadListItem[],
  limit = DEFAULT_ACTIONABLE_THREAD_LIMIT,
): ThreadListItem[] =>
  threads
    .filter(
      (thread) =>
        needsReviewer(thread.status) ||
        (thread.category === "urgent" && !CLOSED_STATUSES.has(thread.status)),
    )
    .slice(0, limit);
