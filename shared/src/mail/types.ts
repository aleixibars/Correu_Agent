// Provider-agnostic shape of the mail a poll brings back. Gmail and Microsoft
// Graph both land here so the worker never speaks a provider's dialect inside a
// job body (context.md §9, §10 — the two providers stay swappable).

/** Mail the mailbox received vs. mail it sent; mirrors `messageDirectionEnum`. */
export type MailMessageDirection = "inbound" | "outbound";

/** One message as the provider reports it, ready to be persisted (context.md §7). */
export interface ProviderMessage {
  providerMessageId: string;
  /** Triage happens per thread, never per message (context.md §4). */
  providerThreadId: string;
  direction: MailMessageDirection;
  /** RFC 5322 headers, so a draft replies inside the thread (context.md §4). */
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: Date | null;
}

export interface MailPollResult {
  /** Messages that appeared since the cursor the poll started from. */
  messages: ProviderMessage[];
  /** Where the next poll resumes from; persisted on `mailbox_accounts.sync_cursor`. */
  cursor: string;
  /**
   * The provider could not resume from the stored cursor (Gmail expires history
   * after a week) and it was reset to "now". Mail that arrived in the meantime
   * is not recoverable through history, and the backlog is deliberately not
   * imported (context.md §4).
   */
  cursorReset: boolean;
}

/** What the worker needs from a mail provider to poll one mailbox. */
export interface MailProviderClient {
  /** `null` on a mailbox with no cursor yet: nothing is returned, only a fresh cursor. */
  fetchNewMessages(cursor: string | null): Promise<MailPollResult>;
}

/**
 * A reply on its way out of the mailbox, in the one shape both providers accept
 * (context.md §2 — approving a draft really sends it). Recipients and threading
 * headers come from the message being answered, never from the model.
 */
export interface OutgoingReply {
  /** The connected mailbox the reply is sent from. */
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  /**
   * Blind copies the reviewer added on approval (context.md §2). The other
   * recipients must never learn of them: Gmail strips the `Bcc` header on
   * delivery, and Graph sends `bccRecipients` without writing a header at all.
   */
  bccAddresses: string[];
  /** Subject of the reply, already carrying its `Re:` prefix. */
  subject: string;
  bodyText: string;
  /** Gmail `threadId` / Graph `conversationId`, so the reply lands in the thread. */
  providerThreadId: string;
  /** Provider id of the message being answered — Graph threads a reply from it. */
  inReplyToProviderMessageId: string;
  /** RFC 5322 threading headers built by `buildReplyHeaders` (context.md §4). */
  inReplyTo: string | null;
  references: string | null;
}

/** What the provider says about the mail it has just sent. */
export interface SentReply {
  providerMessageId: string;
  /** The `Message-ID` the provider stamped; null when it does not report one. */
  messageIdHeader: string | null;
}

/**
 * Sending one reply, the only mail-writing capability the product needs. Kept
 * apart from `MailProviderClient` because polling and sending are reached from
 * different places — the worker polls, the dashboard sends on approval.
 */
export interface MailSenderClient {
  sendReply(reply: OutgoingReply): Promise<SentReply>;
}
