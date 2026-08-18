// Persists a connected Gmail mailbox (context.md §7): the OAuth exchange runs,
// the tokens are encrypted at the application layer, and one `mailbox_accounts`
// row is written for the tenant. Kept out of the route handler so the whole
// flow is exercised by tests with Google mocked.

import { sql } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mailboxAccounts } from "@correu-agent/shared/db/schema";
import {
  encryptToken,
  loadTokenEncryptionKey,
} from "@correu-agent/shared/token-encryption";
import {
  GOOGLE_MAILBOX_SCOPES,
  exchangeGoogleAuthorizationCode,
  fetchGmailProfile,
  googleAccountIdFromIdToken,
  type GoogleOAuthClient,
} from "./google-oauth";

export type MailboxConnectionErrorCode =
  /** Google (or Gmail) turned the exchange down — expired code, revoked client. */
  | "oauth_failed"
  /** The consent screen came back without the grants the product needs. */
  | "scopes_refused";

export class MailboxConnectionError extends Error {
  constructor(
    readonly code: MailboxConnectionErrorCode,
    message: string,
    options?: { cause: unknown },
  ) {
    super(message, options);
    this.name = "MailboxConnectionError";
  }
}

export interface ConnectGoogleMailboxParams {
  tenantId: string;
  /** Who connected it; the row survives the user being deleted (`set null`). */
  userId: string;
  code: string;
  codeVerifier: string;
  client: GoogleOAuthClient;
  /** Defaults to the key in `TOKEN_ENCRYPTION_KEY`. */
  encryptionKey?: Buffer;
}

export interface ConnectedMailbox {
  id: string;
  emailAddress: string;
}

/** `openid` is only there for the account id, so a refusal of it is harmless. */
const REQUIRED_SCOPES = GOOGLE_MAILBOX_SCOPES.filter(
  (scope) => scope !== "openid",
);

// Generic over the schema the connection was opened with, so the app's database
// and a bare test one are both accepted — same shape as `recordAuditLogEntry`.
export const connectGoogleMailbox = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  {
    tenantId,
    userId,
    code,
    codeVerifier,
    client,
    encryptionKey,
  }: ConnectGoogleMailboxParams,
): Promise<ConnectedMailbox> => {
  const tokens = await exchangeGoogleAuthorizationCode(client, {
    code,
    codeVerifier,
  }).catch((cause: unknown) => {
    throw new MailboxConnectionError(
      "oauth_failed",
      "Could not exchange the Google authorization code.",
      { cause },
    );
  });

  // Google's consent screen lets the user untick individual grants. A mailbox
  // missing one would poll happily and then fail at the first send, so it is
  // refused here rather than stored half-connected.
  const missing = REQUIRED_SCOPES.filter(
    (scope) => !tokens.scopes.includes(scope),
  );
  if (missing.length > 0) {
    throw new MailboxConnectionError(
      "scopes_refused",
      `The mailbox grant is incomplete, missing: ${missing.join(", ")}.`,
    );
  }

  // `openid` is among the requested scopes, so Google always answers with an
  // id_token; without it there is no stable account id to key the mailbox on.
  if (!tokens.idToken) {
    throw new MailboxConnectionError(
      "oauth_failed",
      "Google returned no id_token, so the mailbox has no account id.",
    );
  }

  const profile = await fetchGmailProfile(tokens.accessToken).catch(
    (cause: unknown) => {
      throw new MailboxConnectionError(
        "oauth_failed",
        "Could not read the Gmail profile of the connected mailbox.",
        { cause },
      );
    },
  );

  const key = encryptionKey ?? loadTokenEncryptionKey();
  const [connected] = await db
    .insert(mailboxAccounts)
    .values({
      tenantId,
      userId,
      provider: "google",
      emailAddress: profile.emailAddress,
      providerAccountId: googleAccountIdFromIdToken(tokens.idToken),
      accessTokenEncrypted: encryptToken(tokens.accessToken, key),
      refreshTokenEncrypted: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, key)
        : null,
      tokenExpiresAt: tokens.expiresAt,
      // Only mail newer than the connection is processed (context.md §4), so
      // polling resumes from the history cursor as it stands right now.
      syncCursor: profile.historyId,
    })
    .onConflictDoUpdate({
      target: [
        mailboxAccounts.tenantId,
        mailboxAccounts.provider,
        mailboxAccounts.emailAddress,
      ],
      set: {
        userId: sql`excluded.user_id`,
        providerAccountId: sql`excluded.provider_account_id`,
        accessTokenEncrypted: sql`excluded.access_token_encrypted`,
        // Re-consent does not always re-issue a refresh token, and dropping the
        // stored one would leave the worker unable to poll.
        refreshTokenEncrypted: sql`coalesce(excluded.refresh_token_encrypted, ${mailboxAccounts.refreshTokenEncrypted})`,
        tokenExpiresAt: sql`excluded.token_expires_at`,
        // `syncCursor` and `connectedAt` are deliberately left alone: moving
        // them forward on a reconnect would skip the mail that arrived while
        // the mailbox was disconnected.
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: mailboxAccounts.id });

  return { id: connected!.id, emailAddress: profile.emailAddress };
};
