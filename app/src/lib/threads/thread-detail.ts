// Un fil obert al tauler (context.md §2): el correu que hi ha arribat i
// l'esborrany que n'espera revisió, que és el que el revisor aprova, descarta o
// fa regenerar. Fora del Server Component perquè les consultes es puguin provar
// sense arrencar Next.

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TriageCategory } from "@correu-agent/shared";
import { defaultReplyRecipients } from "@correu-agent/shared/drafts";
import {
  drafts,
  messageAttachments,
  messages,
  threads,
} from "@correu-agent/shared/db/schema";
import type { DraftOption, DraftStatus } from "@correu-agent/shared/db/schema";
import { isUuid } from "../uuid";
import { threadStatus, type ThreadStatus } from "./thread-status";

/**
 * Un fitxer que va arribar amb el missatge. Només se'n guarden les metadades:
 * els bytes es demanen al proveïdor quan el tauler els serveix (context.md §7),
 * i `id` és el que la ruta de descàrrega rep.
 */
export interface ThreadDetailAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface ThreadDetailMessage {
  id: string;
  /** Inbound is the correspondent, outbound is the mailbox answering. */
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  /** Null once the 90-day retention window purged it; the snippet survives it. */
  bodyText: string | null;
  snippet: string | null;
  sentAt: Date | null;
  /** Els adjunts del missatge, sense els que el correu incrusta al cos mateix. */
  attachments: ThreadDetailAttachment[];
}

export interface ThreadDetailDraft {
  id: string;
  body: string;
  status: DraftStatus;
  /** The model that wrote it (context.md §6); null on a draft stored without one. */
  model: string | null;
  createdAt: Date;
  /**
   * At least one option to approve; more than one only when the model wrote
   * real alternatives (context.md §2). A draft with a single option carries
   * one entry here too, so the reviewer screen has one shape to render.
   */
  options: DraftOption[];
  /**
   * The addresses the reply leaves with, which the reviewer edits before
   * approving (context.md §2). On a draft still pending these are the ones the
   * thread implies; on one already sent they are the ones it really went to,
   * blind copies included — nothing else records those.
   */
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
}

export interface ThreadDetail {
  id: string;
  subject: string | null;
  /** Null only while the triage tick has not reached the thread yet. */
  category: TriageCategory | null;
  lastMessageAt: Date | null;
  status: ThreadStatus;
  /** Oldest first — the conversation reads the way it happened. */
  messages: ThreadDetailMessage[];
  /** The draft that still says something about the thread, or null. */
  draft: ThreadDetailDraft | null;
}

export interface LoadThreadDetailOptions {
  tenantId: string;
  threadId: string;
  /** How much mail the page shows; the PoC has no "load older" control yet. */
  messageLimit?: number;
}

export const DEFAULT_THREAD_MESSAGE_LIMIT = 50;

/**
 * The draft as the review screen needs it: at least one option to approve, and
 * the recipients to show in the form — its own once it has any, the thread's
 * until then.
 */
const draftDetail = (draft: {
  id: string;
  body: string;
  status: DraftStatus;
  model: string | null;
  createdAt: Date;
  options: DraftOption[] | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  parentFromAddress: string | null;
}): ThreadDetailDraft => {
  const { parentFromAddress, options, ...rest } = draft;
  const stored =
    draft.toAddresses.length > 0 ||
    draft.ccAddresses.length > 0 ||
    draft.bccAddresses.length > 0;

  return {
    ...rest,
    options: options ?? [{ label: "Resposta", body: draft.body }],
    ...(stored ? {} : defaultReplyRecipients(parentFromAddress)),
  };
};

/**
 * One thread with its mail and its live draft, or null when the tenant has no
 * such thread — a thread id is a URL segment, so another tenant's thread has to
 * read as missing rather than as readable.
 */
export const loadThreadDetail = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  {
    tenantId,
    threadId,
    messageLimit = DEFAULT_THREAD_MESSAGE_LIMIT,
  }: LoadThreadDetailOptions,
): Promise<ThreadDetail | null> => {
  // A thread id is a URL segment, so it is arbitrary text: one Postgres would
  // refuse as a malformed uuid has to read as missing too, not as a 500 on a
  // mistyped link.
  if (!isUuid(threadId)) return null;

  const [thread] = await db
    .select({
      id: threads.id,
      subject: threads.subject,
      category: threads.category,
      triagedAt: threads.triagedAt,
      lastMessageAt: threads.lastMessageAt,
    })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.tenantId, tenantId)))
    .limit(1);

  if (!thread) return null;

  const [draft] = await db
    .select({
      id: drafts.id,
      body: drafts.body,
      status: drafts.status,
      model: drafts.model,
      createdAt: drafts.createdAt,
      options: drafts.options,
      toAddresses: drafts.toAddresses,
      ccAddresses: drafts.ccAddresses,
      bccAddresses: drafts.bccAddresses,
      // Who the reply would go to when the draft has no recipients of its own
      // yet. Left-joined, so a draft whose parent message is gone still loads
      // and the screen renders instead of 500ing; it cannot be sent either way
      // — a reply needs the mail it answers, and the send says so by name.
      parentFromAddress: messages.fromAddress,
    })
    .from(drafts)
    .leftJoin(messages, eq(messages.id, drafts.inReplyToMessageId))
    // A regeneration supersedes the draft it replaces (context.md §2), so those
    // are skipped: the text they hold is no longer the thread's answer.
    .where(
      and(eq(drafts.threadId, threadId), ne(drafts.status, "superseded")),
    )
    .orderBy(desc(drafts.createdAt))
    .limit(1);

  const mail = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      fromAddress: messages.fromAddress,
      toAddresses: messages.toAddresses,
      subject: messages.subject,
      bodyText: messages.bodyText,
      snippet: messages.snippet,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    // Newest first with the limit, then reversed: a long thread has to be cut
    // at the end nobody is answering, not at the mail that just arrived.
    .orderBy(sql`${messages.sentAt} desc nulls last`)
    .limit(messageLimit);

  const attachments = await loadAttachments(
    db,
    mail.map(({ id }) => id),
  );

  const { triagedAt, ...rest } = thread;
  return {
    ...rest,
    status: threadStatus({ triagedAt, draftStatus: draft?.status ?? null }),
    messages: [...mail].reverse().map((message) => ({
      ...message,
      attachments: attachments.get(message.id) ?? [],
    })),
    draft: draft ? draftDetail(draft) : null,
  };
};

/**
 * Els adjunts del correu que la pàgina ensenya, per missatge. Els incrustats al
 * cos (la imatge d'una signatura) no hi són: qui llegeix el fil espera la
 * llista de fitxers que li han enviat, no la dels trossos del missatge.
 *
 * No cal filtrar per tenant: els missatges ja venen del fil que s'ha comprovat
 * que és del tenant.
 */
const loadAttachments = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  messageIds: string[],
): Promise<Map<string, ThreadDetailAttachment[]>> => {
  const byMessage = new Map<string, ThreadDetailAttachment[]>();
  if (messageIds.length === 0) return byMessage;

  const rows = await db
    .select({
      id: messageAttachments.id,
      messageId: messageAttachments.messageId,
      filename: messageAttachments.filename,
      mimeType: messageAttachments.mimeType,
      sizeBytes: messageAttachments.sizeBytes,
    })
    .from(messageAttachments)
    .where(
      and(
        inArray(messageAttachments.messageId, messageIds),
        eq(messageAttachments.inline, false),
      ),
    )
    // All the attachments of one poll share a `createdAt`, so without the id
    // the list of a message could come back in a different order each visit.
    .orderBy(asc(messageAttachments.createdAt), asc(messageAttachments.id));

  for (const { messageId, ...attachment } of rows) {
    const group = byMessage.get(messageId);
    if (group) group.push(attachment);
    else byMessage.set(messageId, [attachment]);
  }
  return byMessage;
};
