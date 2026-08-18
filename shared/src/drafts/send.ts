// Sending a draft for real (context.md §2). Two ways in, one way out: the user
// approves it in the dashboard, or a category's auto-reply rule sends it with
// nobody approving anything. Either way the mail leaves through the provider the
// thread's mailbox is connected to, is stored as an outbound message of the
// thread, and lands in the audit trail (context.md §7).

import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { findEnabledAutoReplyRule } from "../auto-reply/rules";
import {
  drafts,
  mailboxAccounts,
  messages,
  threads,
  type DraftStatus,
} from "../db/schema";
import type { MailSenderClient } from "../mail/types";
import type { TriageCategory } from "../triage/taxonomy";
import { buildReplyHeaders, replySubject } from "./reply-headers";

export interface ApproveAndSendDraftInput {
  tenantId: string;
  draftId: string;
  /** The dashboard user approving it — the audit trail's accountability anchor. */
  actorUserId: string;
  /** The text as the user edited it before approving; absent means the model's. */
  body?: string;
  /** Stamp for the send; defaults to the wall clock. */
  now?: Date;
}

export interface SendAutoReplyDraftInput {
  tenantId: string;
  draftId: string;
  /** Stamp for the send; defaults to the wall clock. */
  now?: Date;
}

export interface SentDraft {
  draftId: string;
  threadId: string;
  /** The outbound message row the reply was stored as. */
  sentMessageId: string;
  /** What the provider called the mail it sent. */
  providerMessageId: string;
}

const sendableColumns = {
  status: drafts.status,
  body: drafts.body,
  threadId: drafts.threadId,
  threadSubject: threads.subject,
  providerThreadId: threads.providerThreadId,
  mailboxAddress: mailboxAccounts.emailAddress,
  parentProviderMessageId: messages.providerMessageId,
  parentMessageIdHeader: messages.messageIdHeader,
  parentInReplyTo: messages.inReplyTo,
  parentReferences: messages.references,
  parentFromAddress: messages.fromAddress,
  parentSubject: messages.subject,
  threadCategory: threads.category,
};

/** Everything a send needs about the draft, its thread and the mail it answers. */
interface SendableDraft {
  status: DraftStatus;
  body: string;
  threadId: string;
  threadSubject: string | null;
  providerThreadId: string;
  mailboxAddress: string;
  /** Null when the message the draft answers was deleted — the send then fails with a reason. */
  parentProviderMessageId: string | null;
  parentMessageIdHeader: string | null;
  parentInReplyTo: string | null;
  parentReferences: string | null;
  parentFromAddress: string | null;
  parentSubject: string | null;
  /** Null while the thread is still waiting for triage (context.md §4). */
  threadCategory: TriageCategory | null;
}

/** The draft with its thread, its mailbox and the message it replies to. */
const loadSendableDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, draftId }: { tenantId: string; draftId: string },
): Promise<SendableDraft | undefined> => {
  const [draft] = await db
    .select(sendableColumns)
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxAccounts, eq(mailboxAccounts.id, threads.mailboxAccountId))
    // Left, so a draft whose parent message was deleted still loads and fails
    // with a reason instead of silently looking like a draft that never existed.
    .leftJoin(messages, eq(messages.id, drafts.inReplyToMessageId))
    // Tenant-scoped like every other read a request payload drives.
    .where(and(eq(drafts.id, draftId), eq(drafts.tenantId, tenantId)))
    .limit(1);

  return draft;
};

/**
 * The parts of the draft a mail cannot be built without, or a throw naming what
 * is missing. Both ways in go through it, so an auto-reply is held to exactly
 * the same conditions as an approval.
 */
const requireSendable = (
  draft: SendableDraft,
  draftId: string,
  text: string,
): { parentProviderMessageId: string; parentFromAddress: string } => {
  // The parent message is left-joined, so every column of it is nullable here;
  // an address is the one part a reply cannot be sent without.
  if (!draft.parentProviderMessageId || !draft.parentFromAddress) {
    throw new Error(
      `Draft ${draftId} has no message to reply to: it cannot be sent inside its thread.`,
    );
  }

  if (text.trim() === "") {
    throw new Error(`Draft ${draftId} cannot be sent with an empty body.`);
  }

  return {
    parentProviderMessageId: draft.parentProviderMessageId,
    parentFromAddress: draft.parentFromAddress,
  };
};

/**
 * Moves the draft off `pending` and answers whether this caller is the one that
 * got it. Whoever wins sends the mail; a second approval — or an auto-reply
 * racing the user's click — matches nothing and sends nothing.
 */
const claimDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  {
    tenantId,
    draftId,
    body,
    now,
  }: { tenantId: string; draftId: string; body: string; now: Date },
): Promise<boolean> => {
  const [claimed] = await db
    .update(drafts)
    .set({ status: "approved", body, updatedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.tenantId, tenantId),
        eq(drafts.status, "pending"),
      ),
    )
    .returning({ id: drafts.id });

  return Boolean(claimed);
};

/**
 * Puts the mail on its way and records what came of it: the reply leaves through
 * the provider, is stored as outbound mail of the thread, and the draft is
 * marked sent. Shared by both ways in, so an auto-reply and an approval put the
 * same mail in the same place — only the audit entry that follows differs.
 */
const dispatchDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  sender: MailSenderClient,
  {
    tenantId,
    draftId,
    draft,
    text,
    now,
  }: {
    tenantId: string;
    draftId: string;
    draft: SendableDraft & {
      parentProviderMessageId: string;
      parentFromAddress: string;
    };
    text: string;
    now: Date;
  },
): Promise<SentDraft> => {
  const replyHeaders = buildReplyHeaders({
    messageIdHeader: draft.parentMessageIdHeader,
    inReplyTo: draft.parentInReplyTo,
    references: draft.parentReferences,
  });
  // `||`, not `??`: a thread whose subject was stored as an empty string falls
  // back to the mail being answered just as a null one does.
  const subject = replySubject(draft.threadSubject || draft.parentSubject);
  // A reply, never a reply-all: the mail answers whoever wrote, and the PoC
  // sends without anyone checking the recipient list afterwards.
  const toAddresses = [draft.parentFromAddress];

  const sent = await sender.sendReply({
    fromAddress: draft.mailboxAddress,
    toAddresses,
    ccAddresses: [],
    subject,
    bodyText: text,
    providerThreadId: draft.providerThreadId,
    inReplyToProviderMessageId: draft.parentProviderMessageId,
    inReplyTo: replyHeaders.inReplyTo,
    references: replyHeaders.references,
  });

  const sentMessageId = await storeSentMessage(db, {
    tenantId,
    threadId: draft.threadId,
    providerMessageId: sent.providerMessageId,
    messageIdHeader: sent.messageIdHeader,
    inReplyTo: replyHeaders.inReplyTo,
    references: replyHeaders.references,
    fromAddress: draft.mailboxAddress,
    toAddresses,
    subject,
    bodyText: text,
    sentAt: now,
  });

  await db
    .update(drafts)
    .set({ status: "sent", sentAt: now, sentMessageId, updatedAt: now })
    .where(and(eq(drafts.id, draftId), eq(drafts.tenantId, tenantId)));

  // The thread has just been spoken in, and the dashboard lists threads by their
  // last message: without this a replied thread would sink under older mail.
  await db
    .update(threads)
    .set({
      lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${now})`,
      updatedAt: now,
    })
    .where(and(eq(threads.id, draft.threadId), eq(threads.tenantId, tenantId)));

  return {
    draftId,
    threadId: draft.threadId,
    sentMessageId,
    providerMessageId: sent.providerMessageId,
  };
};

/**
 * Sends an approved draft and marks it sent, or answers `null` when there was
 * nothing to send — the draft is gone, or it was already sent, discarded or
 * superseded, possibly by whoever clicked a moment earlier.
 *
 * The order is approve, then send, then record: the approval is claimed with a
 * conditional update, so two clicks on the same draft cannot both reach the
 * provider. A send that fails afterwards leaves the draft `approved` rather than
 * `pending` — the mail may or may not have left, and silently offering it for
 * approval again is the one outcome that could send it twice.
 */
export const approveAndSendDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  sender: MailSenderClient,
  { tenantId, draftId, actorUserId, body, now = new Date() }: ApproveAndSendDraftInput,
): Promise<SentDraft | null> => {
  const draft = await loadSendableDraft(db, { tenantId, draftId });
  if (!draft || draft.status !== "pending") return null;

  const text = body ?? draft.body;
  const parent = requireSendable(draft, draftId, text);

  if (!(await claimDraft(db, { tenantId, draftId, body: text, now }))) return null;

  await recordAuditLogEntry(db, {
    action: "draft_approved",
    tenantId,
    actor: { type: "user", userId: actorUserId },
    threadId: draft.threadId,
    draftId,
    // Only when the user rewrote the model's text (context.md §2); an untouched
    // draft has no edit to record.
    ...(text !== draft.body ? { edit: { from: draft.body, to: text } } : {}),
    occurredAt: now,
  });

  const result = await dispatchDraft(db, sender, {
    tenantId,
    draftId,
    draft: { ...draft, ...parent },
    text,
    now,
  });

  await recordAuditLogEntry(db, {
    action: "draft_sent",
    tenantId,
    actor: { type: "user", userId: actorUserId },
    threadId: draft.threadId,
    draftId,
    sentMessageId: result.sentMessageId,
    occurredAt: now,
  });

  return result;
};

/**
 * Sends a draft because the thread's category has auto-reply switched on
 * (context.md §2), with nobody approving it, or answers `null` when it must not
 * be sent that way — the draft is no longer pending, the thread is untriaged, or
 * the rule that would have sent it is off.
 *
 * The rule is re-read here rather than trusted from whatever asked for the send:
 * a switch turned off while the model was writing has to stop the mail, and a
 * category that can never be auto-replied to (Urgent, Personal/Altres) is
 * refused without reading the table at all. The draft is left `pending` in every
 * refused case, so the dashboard can still approve it by hand.
 *
 * The mail is sent exactly as an approval sends it; the trail differs, and says
 * so: one `auto_reply_sent` entry by the system, never a `draft_approved` one
 * that would read as if a person had signed it off (context.md §7).
 */
export const sendAutoReplyDraft = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  sender: MailSenderClient,
  { tenantId, draftId, now = new Date() }: SendAutoReplyDraftInput,
): Promise<SentDraft | null> => {
  const draft = await loadSendableDraft(db, { tenantId, draftId });
  if (!draft || draft.status !== "pending") return null;

  // An untriaged thread has no category whose rule could have asked for this.
  const category = draft.threadCategory;
  if (!category) return null;

  const rule = await findEnabledAutoReplyRule(db, { tenantId, category });
  if (!rule) return null;

  const text = draft.body;
  const parent = requireSendable(draft, draftId, text);

  if (!(await claimDraft(db, { tenantId, draftId, body: text, now }))) return null;

  const result = await dispatchDraft(db, sender, {
    tenantId,
    draftId,
    draft: { ...draft, ...parent },
    text,
    now,
  });

  await recordAuditLogEntry(db, {
    action: "auto_reply_sent",
    tenantId,
    actor: { type: "system" },
    threadId: draft.threadId,
    draftId,
    category,
    sentMessageId: result.sentMessageId,
    occurredAt: now,
  });

  return result;
};

interface SentMessageRow {
  tenantId: string;
  threadId: string;
  providerMessageId: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  bodyText: string;
  sentAt: Date;
}

/**
 * Stores the mail that was just sent as an outbound message of the thread — it
 * is what stops the next drafting tick from answering the same mail again, and
 * what the audit entry points at.
 *
 * A Gmail poll can store the sent mail first (it appears in the mailbox's own
 * history), so a conflict here is the poll having won the race, not an error:
 * the row it wrote is the same message and is used as it stands.
 */
const storeSentMessage = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  row: SentMessageRow,
): Promise<string> => {
  const [stored] = await db
    .insert(messages)
    .values({ ...row, direction: "outbound", ccAddresses: [] })
    .onConflictDoNothing({
      target: [messages.threadId, messages.providerMessageId],
    })
    .returning({ id: messages.id });

  if (stored) return stored.id;

  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, row.threadId),
        eq(messages.providerMessageId, row.providerMessageId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error(
      `Reply ${row.providerMessageId} was sent but could not be stored on thread ${row.threadId}.`,
    );
  }
  return existing.id;
};
