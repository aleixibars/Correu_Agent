// Applying an auto-discard rule right after triage (context.md §4): a matching
// thread never gets a reply drafted, and never sits waiting for review. It is
// closed the same way a manually discarded draft is — `discarded` in
// `thread-status.ts` — just written directly, with no Sonnet call that would
// only be thrown away.

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { drafts } from "../db/schema";
import type { TriageCategory } from "../triage/taxonomy";
import { findEnabledAutoDiscardRule } from "./rules";

/**
 * Stored as the draft's body: nobody reads this as an answer to the thread —
 * the status label next to it already says "Esborrany descartat" — it only
 * keeps the `body` column's NOT NULL happy with something legible.
 */
export const AUTO_DISCARD_DRAFT_BODY =
  "Descartat automàticament: aquest fil no necessita resposta ni revisió (regla de descart automàtic).";

export interface ApplyAutoDiscardRuleInput {
  tenantId: string;
  threadId: string;
  category: TriageCategory;
  /** Stamp for the write; defaults to the wall clock. */
  now?: Date;
}

/**
 * Discards a just-triaged thread outright when an enabled auto-discard rule
 * matches it. Answers whether it did — `false` when no rule is enabled for the
 * category; the caller does nothing further either way.
 *
 * The draft this writes is what `listThreadsAwaitingDraft`
 * (`worker/src/drafts/schedule.ts`) already reads to skip a thread: its
 * `notExists` check sees a draft newer than the mail it answers and moves on,
 * exactly as it does for a draft a human discarded by hand. No other wiring is
 * needed for the thread to stop being queued for drafting.
 */
export const applyAutoDiscardRule = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, threadId, category, now = new Date() }: ApplyAutoDiscardRuleInput,
): Promise<boolean> => {
  const rule = await findEnabledAutoDiscardRule(db, { tenantId, category });
  if (!rule) return false;

  const [stored] = await db
    .insert(drafts)
    .values({
      tenantId,
      threadId,
      status: "discarded",
      body: AUTO_DISCARD_DRAFT_BODY,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: drafts.id });

  if (!stored) {
    throw new Error(
      `Thread ${threadId} matched an auto-discard rule but its draft was not stored.`,
    );
  }

  await recordAuditLogEntry(db, {
    action: "thread_auto_discarded",
    tenantId,
    actor: { type: "system" },
    threadId,
    draftId: stored.id,
    category,
    occurredAt: now,
  });

  return true;
};
