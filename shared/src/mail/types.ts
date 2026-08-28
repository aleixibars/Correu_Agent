// Provider-agnostic shape of the mail a poll brings back. Gmail and Microsoft
// Graph both land here so the worker never speaks a provider's dialect inside a
// job body (context.md §9, §10 — the two providers stay swappable).

/** Mail the mailbox received vs. mail it sent; mirrors `messageDirectionEnum`. */
export type MailMessageDirection = "inbound" | "outbound";

/**
 * One file that travelled with a message. Only its metadata crosses this
 * boundary: the bytes are never polled and never stored, they are fetched from
 * the provider when the dashboard actually asks for them (context.md §7 — a PoC
 * at €0/month does not pay to keep a copy of every attachment).
 */
export interface ProviderAttachment {
  /** The provider's handle for the bytes: Gmail `body.attachmentId`, Graph attachment id. */
  providerAttachmentId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /**
   * A part the mail embeds inside its own body (a signature logo), rather than
   * a file the sender attached. Listed apart so the thread view is not buried
   * under the images of every signature.
   */
  inline: boolean;
}

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
  attachments: ProviderAttachment[];
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

/** Which attachment of which message the bytes are wanted for. */
export interface AttachmentRef {
  providerMessageId: string;
  providerAttachmentId: string;
}

/**
 * Fetching the bytes of one attachment on demand, so the dashboard can preview
 * or download it without the product ever storing it. Kept apart from
 * `MailProviderClient` for the same reason `MailSenderClient` is: polling is
 * the worker's job, serving an attachment is the dashboard's.
 */
export interface MailAttachmentClient {
  /** `null` when the provider no longer has it — a deleted mail is not an error. */
  fetchAttachment(ref: AttachmentRef): Promise<Uint8Array | null>;
}

/**
 * Sending one reply, the only mail-writing capability the product needs. Kept
 * apart from `MailProviderClient` because polling and sending are reached from
 * different places — the worker polls, the dashboard sends on approval.
 */
export interface MailSenderClient {
  sendReply(reply: OutgoingReply): Promise<SentReply>;
}
