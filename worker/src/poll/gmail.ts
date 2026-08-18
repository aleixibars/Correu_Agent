// Polling one connected Gmail mailbox (context.md §8): renew the access token if
// it is about to die, ask Gmail what changed since the stored history cursor,
// and move the cursor on. The Gmail calls themselves live in the shared client.

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mailboxAccounts } from "@correu-agent/shared/db/schema";
import {
  createGmailClient,
  loadGoogleOAuthCredentials,
  refreshGoogleAccessToken,
  type GoogleOAuthCredentials,
  type ProviderMessage,
} from "@correu-agent/shared/mail";
import {
  decryptToken,
  encryptToken,
  loadTokenEncryptionKey,
} from "@correu-agent/shared/token-encryption";
import type { PollableMailboxAccount } from "./accounts";

/**
 * A token about to expire mid-poll is as good as expired: Gmail may take a few
 * seconds to answer, so anything inside this window is refreshed up front.
 */
const EXPIRY_SKEW_MS = 60_000;

export interface GmailPollConfig {
  credentials: GoogleOAuthCredentials;
  encryptionKey: Buffer;
  now?: () => Date;
}

/**
 * The worker polls with the same Google app the dashboard connects mailboxes
 * with (context.md §9) — one app, one consent, one pair of secrets.
 */
export const loadGmailPollConfig = (
  env: Record<string, string | undefined> = process.env,
): GmailPollConfig => ({
  credentials: loadGoogleOAuthCredentials(env),
  encryptionKey: loadTokenEncryptionKey(env),
});

/**
 * New mail in one Gmail mailbox since its last poll.
 *
 * The cursor is written after Gmail answered, so a poll that dies mid-flight
 * repeats itself rather than skipping mail; the same message reaching the
 * pipeline twice is settled by the uniqueness of `(thread, provider message id)`
 * when it is persisted.
 */
export const pollGmailMailbox = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  account: PollableMailboxAccount,
  { credentials, encryptionKey, now = () => new Date() }: GmailPollConfig,
): Promise<ProviderMessage[]> => {
  const polledAt = now();
  const accessToken = await currentAccessToken(db, account, {
    credentials,
    encryptionKey,
    polledAt,
  });

  const poll = await createGmailClient(accessToken).fetchNewMessages(
    account.syncCursor,
  );

  // Skipped mail is not recoverable (context.md §4), so it is said out loud
  // rather than only implied by a cursor that jumped.
  if (poll.cursorReset && account.syncCursor) {
    console.warn(
      `Mailbox ${account.emailAddress} lost its Gmail history window; polling resumed at ${poll.cursor} and the mail in between was skipped.`,
    );
  }

  await db
    .update(mailboxAccounts)
    .set({ syncCursor: poll.cursor, lastPolledAt: polledAt })
    .where(
      and(
        eq(mailboxAccounts.id, account.id),
        eq(mailboxAccounts.tenantId, account.tenantId),
      ),
    );

  return poll.messages;
};

/**
 * The stored access token while it lasts, a freshly minted one after that. The
 * new token is persisted encrypted so the next poll two minutes from now does
 * not have to mint another one (context.md §7, §8).
 */
const currentAccessToken = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  account: PollableMailboxAccount,
  {
    credentials,
    encryptionKey,
    polledAt,
  }: {
    credentials: GoogleOAuthCredentials;
    encryptionKey: Buffer;
    polledAt: Date;
  },
): Promise<string> => {
  const expiresAt = account.tokenExpiresAt?.getTime() ?? 0;
  if (
    account.accessTokenEncrypted &&
    expiresAt - EXPIRY_SKEW_MS > polledAt.getTime()
  ) {
    return decryptToken(account.accessTokenEncrypted, encryptionKey);
  }

  if (!account.refreshTokenEncrypted) {
    throw new Error(
      `Mailbox ${account.emailAddress} has no refresh token: it has to be reconnected before it can be polled.`,
    );
  }

  const refreshed = await refreshGoogleAccessToken(
    credentials,
    decryptToken(account.refreshTokenEncrypted, encryptionKey),
  );

  await db
    .update(mailboxAccounts)
    .set({
      accessTokenEncrypted: encryptToken(refreshed.accessToken, encryptionKey),
      tokenExpiresAt: refreshed.expiresAt,
    })
    .where(
      and(
        eq(mailboxAccounts.id, account.id),
        eq(mailboxAccounts.tenantId, account.tenantId),
      ),
    );

  return refreshed.accessToken;
};
