// Drafting a reply to one stored thread (context.md §2): read the mail already
// in the database, ask Sonnet for the reply, store it as a pending draft with
// the headers that keep it inside the thread, and record why.

import { and, eq, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { findEnabledAutoReplyRule } from "../auto-reply/rules";
import { drafts, mailboxAccounts, tenants, threads, users } from "../db/schema";
import { needsDraft } from "../triage/taxonomy";
import { generateReply, type DraftMessagesClient } from "./generate";
import { buildReplyHeaders, type ReplyHeaders } from "./reply-headers";
import { loadThreadMessages } from "./thread-messages";

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
  /**
   * True when an auto-reply rule of the thread's category is on, i.e. the draft
   * is to be sent without anyone approving it (context.md §2). The send itself
   * is the caller's — `sendAutoReplyDraft` re-reads the rule before the mail
   * leaves.
   */
  autoReply: boolean;
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
      // Grounds the reply in whose mailbox it is (`./generate`'s
      // `MailboxToAnswerFor`) — without this the model has no way to tell it is
      // answering a real employee's own inbox rather than a shared alias.
      mailboxEmail: mailboxAccounts.emailAddress,
      ownerName: users.name,
      companyName: tenants.name,
    })
    .from(threads)
    .innerJoin(mailboxAccounts, eq(mailboxAccounts.id, threads.mailboxAccountId))
    .leftJoin(users, eq(users.id, mailboxAccounts.userId))
    .innerJoin(tenants, eq(tenants.id, threads.tenantId))
    // Tenant-scoped like every other read a job payload drives.
    .where(and(eq(threads.id, threadId), eq(threads.tenantId, tenantId)))
    .limit(1);

  // A thread is answered in the register its category sets, so drafting waits
  // for triage (context.md §4) — the next tick picks it up once it has one.
  if (!thread?.category || thread.triagedAt === null) return null;
  // Newsletters and spam are archived, never answered (context.md §2).
  if (!needsDraft(thread.category)) return null;

  // Newest first, because that is the end the reply answers; the prompt gets
  // them the way it renders mail, oldest first.
  const recent = await loadThreadMessages(db, threadId);

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
        or(
          // Per *message*, not per thread: a draft the user discarded must not
          // be written again on the next tick, while mail that arrives
          // afterwards must still get one.
          eq(drafts.inReplyToMessageId, answering.id),
          // A draft still waiting for the user holds the thread's only pending
          // slot (`drafts_thread_pending_idx`), so the insert below would lose
          // to it anyway. Checking here rather than after the call is what
          // stops newer mail from paying Sonnet every two minutes for a row
          // that can never be written; the next tick after the user answers
          // that draft is where this mail gets its own.
          eq(drafts.status, "pending"),
        ),
      ),
    )
    .limit(1);

  if (existing) return null;

  // Read before the model is asked, so the reply is written under whatever
  // standing guidance the rule that will send it carries (context.md §2). An
  // ineligible category answers null without reading the table at all.
  const autoReplyRule = await findEnabledAutoReplyRule(db, {
    tenantId,
    category: thread.category,
  });

  const { body, language, model } = await generateReply(client, {
    subject: thread.subject,
    category: thread.category,
    messages: [...recent].reverse(),
    guidance: autoReplyRule?.instructions,
    mailbox: {
      emailAddress: thread.mailboxEmail,
      ownerName: thread.ownerName,
      companyName: thread.companyName,
    },
  });

  const [stored] = await db
    .insert(drafts)
    .values({
      tenantId,
      threadId,
      inReplyToMessageId: answering.id,
      body,
      autoReply: autoReplyRule !== null,
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
    // Whether a rule asked for this draft or the dashboard will review it
    // (context.md §2) — the first link of "why was this mail sent".
    autoReply: autoReplyRule !== null,
    occurredAt: now,
  });

  return {
    threadId,
    draftId: stored.id,
    inReplyToMessageId: answering.id,
    replyHeaders: buildReplyHeaders(answering),
    language,
    model,
    autoReply: autoReplyRule !== null,
  };
};
