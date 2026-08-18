// Approving a draft really sends the mail (context.md §2): the text the user
// approved leaves through the provider the thread's mailbox is connected to, the
// reply is stored as an outbound message of the thread, and both the approval
// and the send land in the audit trail (context.md §7).

import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { drafts, mailboxAccounts, messages, threads } from "../db/schema";
import type { MailSenderClient } from "../mail/types";
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

export interface SentDraft {
  draftId: string;
  threadId: string;
  /** The outbound message row the reply was stored as. */
  sentMessageId: string;
  /** What the provider called the mail it sent. */
  providerMessageId: string;
}

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
  const [draft] = await db
    .select({
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
    })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxAccounts, eq(mailboxAccounts.id, threads.mailboxAccountId))
    // Left, so a draft whose parent message was deleted still loads and fails
    // with a reason instead of silently looking like a draft that never existed.
    .leftJoin(messages, eq(messages.id, drafts.inReplyToMessageId))
    // Tenant-scoped like every other read a request payload drives.
    .where(and(eq(drafts.id, draftId), eq(drafts.tenantId, tenantId)))
    .limit(1);

  if (!draft || draft.status !== "pending") return null;

  // The parent message is left-joined, so every column of it is nullable here;
  // an address is the one part a reply cannot be sent without.
  if (!draft.parentProviderMessageId || !draft.parentFromAddress) {
    throw new Error(
      `Draft ${draftId} has no message to reply to: it cannot be sent inside its thread.`,
    );
  }

  const text = body ?? draft.body;
  if (text.trim() === "") {
    throw new Error(`Draft ${draftId} cannot be sent with an empty body.`);
  }

  const [claimed] = await db
    .update(drafts)
    .set({ status: "approved", body: text, updatedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.tenantId, tenantId),
        // The claim: whoever moves the draft off `pending` is the one that sends
        // it, and a second approval of the same draft matches nothing.
        eq(drafts.status, "pending"),
      ),
    )
    .returning({ id: drafts.id });

  if (!claimed) return null;

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

  await recordAuditLogEntry(db, {
    action: "draft_sent",
    tenantId,
    actor: { type: "user", userId: actorUserId },
    threadId: draft.threadId,
    draftId,
    sentMessageId,
    occurredAt: now,
  });

  return {
    draftId,
    threadId: draft.threadId,
    sentMessageId,
    providerMessageId: sent.providerMessageId,
  };
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
