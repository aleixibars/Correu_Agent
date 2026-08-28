// Who a reply goes to. Kept apart from the send itself because two callers need
// the same answer: the send, when nobody has said otherwise, and the approval
// screen, which shows the reviewer these addresses to edit before approving
// (context.md §2).

/** The three recipient fields of a reply, as the provider clients take them. */
export interface ReplyRecipients {
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
}

/**
 * The recipients a reply carries when nothing was said about them: whoever
 * wrote, and nobody else. A reply, never a reply-all — an auto-reply is sent
 * with no one looking at the list (context.md §2), and an approval the reviewer
 * left untouched sends exactly the mail it sent before the fields existed.
 */
export const defaultReplyRecipients = (
  parentFromAddress: string | null,
): ReplyRecipients => ({
  toAddresses: parentFromAddress ? [parentFromAddress] : [],
  ccAddresses: [],
  bccAddresses: [],
});
