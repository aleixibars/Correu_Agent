// Polls one connected Gmail mailbox (context.md §8). Everything that talks to
// Google lives behind the typed provider client in `shared/mail`; what is left
// here is the mailbox row: which token to poll with, and where the next poll
// resumes from.

import { and, eq, isNotNull } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
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

/** Which mailbox to poll, for which tenant. */
export interface GmailPollTarget {
  tenantId: string;
  mailboxAccountId: string;
}

export interface GmailPollOutcome extends GmailPollTarget {
  /** New mail since the stored cursor, ready for the persistence step. */
  messages: ProviderMessage[];
  cursor: string;
  /** Gmail had expired the stored cursor, so polling restarted from now. */
  cursorReset: boolean;
}

export interface GmailPollOptions {
  /** Defaults to the Google app credentials in the environment. */
  credentials?: GoogleOAuthCredentials;
  /** Defaults to the key in `TOKEN_ENCRYPTION_KEY`. */
  encryptionKey?: Buffer;
}

/**
 * A token about to expire mid-poll is as good as expired: Gmail may take a few
 * seconds to answer, so anything inside this window is refreshed up front.
 */
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

/**
 * The mailboxes a poll round covers: Gmail accounts that still hold a refresh
 * token. Without one the worker cannot authenticate on its own, and the mailbox
 * has to be reconnected from the dashboard before it can be polled again.
 *
 * Generic over the schema the connection was opened with, so the worker's
 * database and a bare test one are both accepted — same shape as
 * `connectGoogleMailbox`.
 */
export const listGmailPollTargets = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
): Promise<GmailPollTarget[]> =>
  db
    .select({
      tenantId: mailboxAccounts.tenantId,
      mailboxAccountId: mailboxAccounts.id,
    })
    .from(mailboxAccounts)
    .where(
      and(
        eq(mailboxAccounts.provider, "google"),
        isNotNull(mailboxAccounts.refreshTokenEncrypted),
      ),
    );

/**
 * Returns `null` when the mailbox is no longer there: a job queued just before
 * the mailbox was disconnected is stale, not broken, and retrying it forever
 * would only keep a dead job alive.
 */
export const pollGmailMailbox = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  { tenantId, mailboxAccountId }: GmailPollTarget,
  { credentials, encryptionKey }: GmailPollOptions = {},
): Promise<GmailPollOutcome | null> => {
  const [account] = await db
    .select({
      id: mailboxAccounts.id,
      tenantId: mailboxAccounts.tenantId,
      emailAddress: mailboxAccounts.emailAddress,
      syncCursor: mailboxAccounts.syncCursor,
      accessTokenEncrypted: mailboxAccounts.accessTokenEncrypted,
      refreshTokenEncrypted: mailboxAccounts.refreshTokenEncrypted,
      tokenExpiresAt: mailboxAccounts.tokenExpiresAt,
    })
    .from(mailboxAccounts)
    .where(
      and(
        eq(mailboxAccounts.id, mailboxAccountId),
        eq(mailboxAccounts.tenantId, tenantId),
        eq(mailboxAccounts.provider, "google"),
      ),
    )
    .limit(1);

  if (!account) return null;

  const key = encryptionKey ?? loadTokenEncryptionKey();
  const accessToken = await currentAccessToken(db, account, {
    credentials,
    key,
  });

  const poll = await createGmailClient(accessToken).fetchNewMessages(
    account.syncCursor,
  );

  await db
    .update(mailboxAccounts)
    .set({ syncCursor: poll.cursor, lastPolledAt: new Date() })
    .where(eq(mailboxAccounts.id, account.id));

  return {
    tenantId,
    mailboxAccountId,
    messages: poll.messages,
    cursor: poll.cursor,
    cursorReset: poll.cursorReset,
  };
};

type MailboxTokens = {
  id: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
};

/**
 * The stored access token while it lasts, a freshly minted one after that. The
 * new token is persisted encrypted so the next poll two minutes from now does
 * not have to mint another one (context.md §7, §8).
 */
const currentAccessToken = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  account: MailboxTokens,
  {
    credentials,
    key,
  }: { credentials: GoogleOAuthCredentials | undefined; key: Buffer },
): Promise<string> => {
  const expiresAt = account.tokenExpiresAt?.getTime() ?? 0;
  if (account.accessTokenEncrypted && expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return decryptToken(account.accessTokenEncrypted, key);
  }

  if (!account.refreshTokenEncrypted) {
    throw new Error(
      `Mailbox ${account.id} has no refresh token: it has to be reconnected before it can be polled.`,
    );
  }

  const refreshed = await refreshGoogleAccessToken(
    credentials ?? loadGoogleOAuthCredentials(),
    decryptToken(account.refreshTokenEncrypted, key),
  );

  await db
    .update(mailboxAccounts)
    .set({
      accessTokenEncrypted: encryptToken(refreshed.accessToken, key),
      tokenExpiresAt: refreshed.expiresAt,
    })
    .where(eq(mailboxAccounts.id, account.id));

  return refreshed.accessToken;
};
