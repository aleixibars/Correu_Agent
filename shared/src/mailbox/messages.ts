// What a poll hands to the pipeline, in the same words the schema uses
// (`threads.providerThreadId`, `messages.providerMessageId`). Provider-neutral
// on purpose: Gmail and Microsoft Graph name these things differently, and
// nothing downstream of a poll should have to know which mailbox it came from.

export interface MailboxMessageSummary {
  providerMessageId: string;
  /** Triage unit: a Graph `conversationId` / a Gmail `threadId` (context.md §4). */
  providerThreadId: string;
  /** RFC 5322 `Message-ID`, needed so a draft replies inside the thread. */
  messageIdHeader: string | null;
  subject: string | null;
  receivedAt: Date;
}
