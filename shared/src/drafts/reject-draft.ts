// Rejecting a draft (context.md §2): the user either discards it — the thread
// is archived without an answer — or writes an instruction and asks for another
// draft, which is a second Sonnet call carrying the rejected text and the
// feedback. Both are user actions, so both land in the audit trail with the
// user who took them (context.md §7).

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { drafts, threads } from "../db/schema";
import { generateReply, type DraftMessagesClient } from "./generate";
import { loadThreadMessages } from "./thread-messages";

export interface RejectDraftInput {
  tenantId: string;
  draftId: string;
  /** The dashboard user rejecting it — the audit trail's accountability anchor. */
  userId: string;
  /** Stamp for the write; defaults to the wall clock. */
  now?: Date;
}

export interface DiscardedDraft {
  draftId: string;
  threadId: string;
}

export interface RegenerateDraftInput extends RejectDraftInput {
  /** What the user wants changed; an empty instruction is refused. */
  feedback: string;
}

export interface RegeneratedDraft {
  threadId: string;
  /** The draft that now waits for the user. */
  draftId: string;
  /** The rejected draft, which this one replaced. */
  supersededDraftId: string;
  language: string | null;
  model: string;
}

/**
 * Only a draft still waiting for the user can be rejected: the dashboard can be
 * open in two tabs, and an approved or already-discarded draft is not the
 * user's to take back here. The update is the claim — whoever changes the
 * status first is the one that acted.
 */
const claimPendingDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
>(
  db: PgDatabase<T, TSchema>,
  {
    tenantId,
    draftId,
    status,
    feedback,
    now,
  }: {
    tenantId: string;
    draftId: string;
    status: "discarded" | "superseded";
    feedback?: string;
    now: Date;
  },
): Promise<{ id: string; threadId: string } | undefined> => {
  const [claimed] = await db
    .update(drafts)
    .set({ status, ...(feedback === undefined ? {} : { feedback }), updatedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.tenantId, tenantId),
        eq(drafts.status, "pending"),
      ),
    )
    .returning({ id: drafts.id, threadId: drafts.threadId });

  return claimed;
};

/**
 * Discards the draft: the thread is left without an answer (context.md §2).
 * Answers `null` when the draft was no longer pending — someone else already
 * approved, discarded or regenerated it.
 */
export const discardDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, draftId, userId, now = new Date() }: RejectDraftInput,
): Promise<DiscardedDraft | null> => {
  const claimed = await claimPendingDraft(db, {
    tenantId,
    draftId,
    status: "discarded",
    now,
  });
  if (!claimed) return null;

  await recordAuditLogEntry(db, {
    action: "draft_discarded",
    tenantId,
    actor: { type: "user", userId },
    threadId: claimed.threadId,
    draftId: claimed.id,
    occurredAt: now,
  });

  return { draftId: claimed.id, threadId: claimed.threadId };
};

/**
 * Writes the thread another draft, this time with the user's instruction in the
 * prompt, and supersedes the one it replaces (context.md §2). Answers `null`
 * when there is nothing to regenerate: the draft is no longer pending, its
 * thread is gone or untriaged, or the user answered it while the model was
 * writing.
 *
 * The rejected draft is claimed only after the model answered, so a call that
 * fails leaves the user the draft they still have — a thread holds one pending
 * draft at a time (`drafts_thread_pending_idx`), and superseding first would
 * leave it with none and nothing queued to write another.
 */
export const regenerateDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  client: DraftMessagesClient,
  {
    tenantId,
    draftId,
    userId,
    feedback,
    now = new Date(),
  }: RegenerateDraftInput,
): Promise<RegeneratedDraft | null> => {
  const instruction = feedback.trim();
  // Regenerating from nothing is the same call that wrote the rejected draft:
  // it would be paid for to produce the mail the user just turned down.
  if (!instruction) {
    throw new Error("Regenerating a draft needs the feedback that rejects it.");
  }

  const [rejected] = await db
    .select({
      id: drafts.id,
      threadId: drafts.threadId,
      inReplyToMessageId: drafts.inReplyToMessageId,
      body: drafts.body,
      subject: threads.subject,
      category: threads.category,
    })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.tenantId, tenantId),
        eq(drafts.status, "pending"),
      ),
    )
    .limit(1);

  // The category sets the register the reply is written in (context.md §4); a
  // draft cannot exist without one, but the column is nullable.
  if (!rejected?.category) return null;

  const recent = await loadThreadMessages(db, rejected.threadId);

  const { body, language, model } = await generateReply(client, {
    subject: rejected.subject,
    category: rejected.category,
    messages: [...recent].reverse(),
    revision: { previousBody: rejected.body, feedback: instruction },
  });

  const claimed = await claimPendingDraft(db, {
    tenantId,
    draftId,
    status: "superseded",
    // Kept on the draft it judges, so the trail reads as "this text was
    // rejected, and this is why".
    feedback: instruction,
    now,
  });
  if (!claimed) return null;

  const [stored] = await db
    .insert(drafts)
    .values({
      tenantId,
      threadId: rejected.threadId,
      // The replacement answers the same message, so it threads the same way.
      inReplyToMessageId: rejected.inReplyToMessageId,
      body,
      model,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: drafts.id });

  if (!stored) {
    throw new Error(
      `Draft ${draftId} was superseded but its replacement was not stored.`,
    );
  }

  await recordAuditLogEntry(db, {
    action: "draft_regenerated",
    tenantId,
    actor: { type: "user", userId },
    threadId: rejected.threadId,
    draftId: claimed.id,
    replacementDraftId: stored.id,
    feedback: instruction,
    occurredAt: now,
  });

  // The replacement gets its own entry, so the two are linked rather than
  // collapsed into one (context.md §7).
  await recordAuditLogEntry(db, {
    action: "draft_generated",
    tenantId,
    actor: { type: "system" },
    threadId: rejected.threadId,
    draftId: stored.id,
    model,
    language,
    // Auto-reply rules are opt-in per category and are not what asked for this
    // one (context.md §2).
    autoReply: false,
    occurredAt: now,
  });

  return {
    threadId: rejected.threadId,
    draftId: stored.id,
    supersededDraftId: claimed.id,
    language,
    model,
  };
};
