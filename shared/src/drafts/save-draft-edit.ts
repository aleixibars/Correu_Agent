// Autosaving a draft while the reviewer edits it (context.md §2): the review
// screen keeps the text in a browser field, so a closed tab, a navigation or an
// expired session used to throw away everything typed since the model wrote it.
// The text is parked on the draft itself, apart from `body` — the reviewer has
// not decided anything yet, so `body` stays the model's text and the draft
// stays `pending`.

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drafts } from "../db/schema";

export interface SaveDraftEditInput {
  tenantId: string;
  draftId: string;
  /** The field as it stands; an empty one is refused. */
  body: string;
  /** Stamp for the write; defaults to the wall clock. */
  now?: Date;
}

export interface SavedDraftEdit {
  draftId: string;
  threadId: string;
}

/**
 * Keeps what the reviewer has written so far, so reopening the thread shows it
 * back instead of the text the model wrote. Answers `null` when the draft is no
 * longer `pending`: approving, discarding and regenerating all decide the
 * draft, and an autosave that arrives after one of those has nothing left to
 * edit — which is also what stops a timer that fires mid-approval.
 *
 * No audit entry: nothing has been decided, and the trail's question ("why was
 * this mail sent", context.md §7) is answered by the approval, which records
 * the text that really left against the one the model wrote.
 */
export const saveDraftEdit = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, draftId, body, now = new Date() }: SaveDraftEditInput,
): Promise<SavedDraftEdit | null> => {
  // An empty field is not an edit worth keeping: stored, it would leave the
  // reviewer staring at nothing where the model's text used to be, with no way
  // back to it from the screen.
  if (body.trim() === "") {
    throw new Error(`Draft ${draftId} cannot be autosaved with an empty body.`);
  }

  const [saved] = await db
    .update(drafts)
    .set({ editedBody: body, updatedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.tenantId, tenantId),
        eq(drafts.status, "pending"),
      ),
    )
    .returning({ id: drafts.id, threadId: drafts.threadId });

  return saved ? { draftId: saved.id, threadId: saved.threadId } : null;
};
