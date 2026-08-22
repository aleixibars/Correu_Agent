// What the dashboard home leads with (context.md §2): threads the triatge
// tick has already classified and that still need something from the
// reviewer, so the initial screen answers "what's waiting for me" without a
// click into /fils. A thread still awaiting triage never shows up here — it
// is not the reviewer's turn yet, it is the triatge's (context.md §4).

import type { ThreadListItem } from "./list-threads";

/** How many threads the home page shows before pointing to the full list. */
export const DEFAULT_ACTIONABLE_THREAD_LIMIT = 10;

const CLOSED_STATUSES = new Set(["replied", "draft-discarded"]);

// Triaged but with no draft yet: nothing for the reviewer to decide until the
// next drafting tick writes one — even for urgent mail, this is noise, not
// something waiting on the reviewer.
const NOT_YET_DECIDABLE_STATUSES = new Set(["triaged"]);

const needsReviewer = (status: ThreadListItem["status"]): boolean =>
  status === "draft-pending";

/**
 * Threads with a live draft waiting on the reviewer, plus urgent threads that
 * have not been closed out yet — even once drafted, urgent mail stays visible
 * until it is replied to or its draft discarded. Triaged-but-undrafted
 * threads never show up here, urgent or not: there is nothing to decide yet.
 */
export const actionableThreads = (
  threads: ThreadListItem[],
  limit = DEFAULT_ACTIONABLE_THREAD_LIMIT,
): ThreadListItem[] =>
  threads
    .filter(
      (thread) =>
        needsReviewer(thread.status) ||
        (thread.category === "urgent" &&
          !CLOSED_STATUSES.has(thread.status) &&
          !NOT_YET_DECIDABLE_STATUSES.has(thread.status)),
    )
    .slice(0, limit);
