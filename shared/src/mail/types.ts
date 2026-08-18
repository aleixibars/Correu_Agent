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
