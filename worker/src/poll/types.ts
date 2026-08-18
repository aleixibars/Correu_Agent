// What one mailbox poll hands back, whichever provider answered it.

import type { ProviderMessage } from "@correu-agent/shared/mail";

export interface MailboxPoll {
  /** New mail since the stored cursor, oldest first. */
  messages: ProviderMessage[];
  /**
   * Moves the mailbox cursor on. The cursor is the only record of what has
   * already been seen, so it is advanced *after* the mail is stored: a poll
   * that dies in between then repeats itself, where one that had already moved
   * the cursor would be asking for mail the provider never offers again.
   */
  commit: () => Promise<void>;
}
