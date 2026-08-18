// Sending the draft a category's auto-reply rule asked for (context.md §2). The
// mail leaves through the same shared send path an approval uses; what this adds
// is the provider client for the mailbox the thread belongs to, built from the
// same grant the 2-minute poll reads that mailbox with.

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { threads } from "@correu-agent/shared/db/schema";
import { sendAutoReplyDraft, type SentDraft } from "@correu-agent/shared/drafts";
import { createGmailSender } from "@correu-agent/shared/mail";
import { createMicrosoftSender } from "@correu-agent/shared/mailbox";
import type { MailSenderClient } from "@correu-agent/shared/mail";
import {
  loadPollableMailboxAccount,
  type PollableMailboxAccount,
} from "../poll/accounts";
import { resolveGmailAccessToken, type GmailPollConfig } from "../poll/gmail";
import {
  resolveMicrosoftAccessToken,
  type MicrosoftPollConfig,
} from "../poll/microsoft";

export interface ThreadAutoReplyTarget {
  tenantId: string;
  threadId: string;
  draftId: string;
  /** Stamp for the send; defaults to the wall clock. */
  now?: Date;
}

/**
 * Sends one auto-reply, or answers `null` when there is nothing to send — the
 * draft is no longer pending, the rule was switched off while the model was
 * writing, or the mailbox was disconnected in between. Injected into the
 * drafting queue handler so it can be stubbed there.
 */
export type ThreadAutoReplySender = (
  target: ThreadAutoReplyTarget,
) => Promise<SentDraft | null>;

export interface ThreadAutoReplyDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
  google: GmailPollConfig;
  microsoft: MicrosoftPollConfig;
}

export const createThreadAutoReplySender = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  db,
  google,
  microsoft,
}: ThreadAutoReplyDeps<T, TSchema>): ThreadAutoReplySender => {
  const senderFor = async (
    account: PollableMailboxAccount,
  ): Promise<MailSenderClient> => {
    switch (account.provider) {
      case "google":
        return createGmailSender(
          await resolveGmailAccessToken(db, account, google),
        );
      case "microsoft":
        return createMicrosoftSender({
          accessToken: await resolveMicrosoftAccessToken(db, account, microsoft),
          fetch: microsoft.fetch,
        });
      default:
        throw new Error(
          `No sender for a ${account.provider} mailbox (${account.emailAddress}): the auto-reply cannot be sent.`,
        );
    }
  };

  return async ({ tenantId, threadId, draftId, now }) => {
    const [thread] = await db
      .select({ mailboxAccountId: threads.mailboxAccountId })
      .from(threads)
      // Tenant-scoped like every other read a job payload drives.
      .where(and(eq(threads.id, threadId), eq(threads.tenantId, tenantId)))
      .limit(1);

    if (!thread) return null;

    // Re-read rather than carried from the drafting call: the tokens move while
    // the model is writing, and a mailbox disconnected in between has no grant
    // left to send with.
    const account = await loadPollableMailboxAccount(db, {
      tenantId,
      mailboxAccountId: thread.mailboxAccountId,
    });
    if (!account) return null;

    return sendAutoReplyDraft(db, await senderFor(account), {
      tenantId,
      draftId,
      now,
    });
  };
};
