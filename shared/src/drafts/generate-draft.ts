// Drafting a reply to one stored thread (context.md §2): read the mail already
// in the database, ask Sonnet for the reply, store it as a pending draft with
// the headers that keep it inside the thread, and record why.

import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { drafts, messages, threads } from "../db/schema";
import { needsDraft } from "../triage/taxonomy";
import {
  MAX_THREAD_MESSAGES,
  generateReply,
  type DraftMessagesClient,
} from "./generate";
import { buildReplyHeaders, type ReplyHeaders } from "./reply-headers";

export interface GenerateThreadDraftInput {
  tenantId: string;
  threadId: string;
  /** Stamp for the draft; defaults to the wall clock. */
  now?: Date;
}

export interface GeneratedThreadDraft {
  threadId: string;
  draftId: string;
  /** The message the draft answers — where its threading headers come from. */
  inReplyToMessageId: string;
  /** RFC 5322 headers the send has to put on the mail (context.md §4). */
  replyHeaders: ReplyHeaders;
  language: string | null;
  model: string;
}

/**
 * Writes the reply to one thread and stores it as a pending draft, or does
 * nothing and answers `null` — the thread is gone or untriaged, its category is
 * never answered (newsletters and spam), the mailbox already replied, the mail
 * that arrived was already drafted for, or another worker drafted it while this
 * one was asking the model.
 */
export const generateThreadDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  client: DraftMessagesClient,
  { tenantId, threadId, now = new Date() }: GenerateThreadDraftInput,
): Promise<GeneratedThreadDraft | null> => {
  const [thread] = await db
    .select({
      subject: threads.subject,
      category: threads.category,
      triagedAt: threads.triagedAt,
    })
    .from(threads)
    // Tenant-scoped like every other read a job payload drives.
    .where(and(eq(threads.id, threadId), eq(threads.tenantId, tenantId)))
    .limit(1);

  // A thread is answered in the register its category sets, so drafting waits
  // for triage (context.md §4) — the next tick picks it up once it has one.
  if (!thread?.category || thread.triagedAt === null) return null;
  // Newsletters and spam are archived, never answered (context.md §2).
  if (!needsDraft(thread.category)) return null;

  const recent = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      bodyText: messages.bodyText,
      snippet: messages.snippet,
      messageIdHeader: messages.messageIdHeader,
      inReplyTo: messages.inReplyTo,
      references: messages.references,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    // Newest first, because that is the end the model reads and the end the
    // reply answers; the prompt gets them the way it renders mail, oldest first.
    .orderBy(desc(messages.sentAt))
    .limit(MAX_THREAD_MESSAGES);

  const answering = recent[0];
  // Nothing stored yet (the poll writes the thread and its mail as two
  // statements), or the last word is already ours: an outbound message means the
  // thread was answered, and the next inbound one is what earns a new draft.
  if (!answering || answering.direction === "outbound") return null;

  const [existing] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.tenantId, tenantId),
        eq(drafts.threadId, threadId),
        // Per *message*, not per thread: a draft the user discarded must not be
        // written again on the next tick, while mail that arrives afterwards
        // must still get one.
        eq(drafts.inReplyToMessageId, answering.id),
      ),
    )
    .limit(1);

  if (existing) return null;

  const { body, language, model } = await generateReply(client, {
    subject: thread.subject,
    category: thread.category,
    messages: [...recent].reverse(),
  });

  const [stored] = await db
    .insert(drafts)
    .values({
      tenantId,
      threadId,
      inReplyToMessageId: answering.id,
      body,
      model,
      createdAt: now,
      updatedAt: now,
    })
    // Drafting is a slow call, so two workers can reach here with the same
    // thread. Only one pending draft per thread exists (`drafts_thread_pending_idx`),
    // and the first one to arrive is it.
    .onConflictDoNothing()
    .returning({ id: drafts.id });

  if (!stored) return null;

  await recordAuditLogEntry(db, {
    action: "draft_generated",
    tenantId,
    actor: { type: "system" },
    threadId,
    draftId: stored.id,
    model,
    language,
    // Auto-reply rules are opt-in per category and are not what asked for this
    // one (context.md §2).
    autoReply: false,
    occurredAt: now,
  });

  return {
    threadId,
    draftId: stored.id,
    inReplyToMessageId: answering.id,
    replyHeaders: buildReplyHeaders(answering),
    language,
    model,
  };
};
