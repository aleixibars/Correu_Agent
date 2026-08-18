// Persisting a connected mailbox (context.md §7). The provider clients hand
// their tokens here and never touch `mailbox_accounts` themselves, so the
// application-layer encryption is applied in exactly one place.

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mailboxAccounts, type MailProvider } from "../db/schema";
import { encryptToken } from "../token-encryption";

export interface MailboxTokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working; the worker refreshes from here. */
  expiresAt: Date;
}

export interface ConnectMailboxAccountInput {
  tenantId: string;
  /** Who connected it; the row survives (with a null user) if that user is deleted. */
  userId?: string | null;
  provider: MailProvider;
  emailAddress: string;
  providerAccountId: string;
  tokens: MailboxTokens;
  encryptionKey: Buffer;
}

/**
 * Inserts the mailbox, or refreshes the credentials of one already connected —
 * re-consenting is the normal way to recover a mailbox whose refresh token was
 * revoked, and it must not look like a brand-new connection.
 *
 * Returns the mailbox account id. Generic over the query-result type so it takes
 * the app's connection, the worker's, or a transaction handle.
 */
export const connectMailboxAccount = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  {
    tenantId,
    userId = null,
    provider,
    emailAddress,
    providerAccountId,
    tokens,
    encryptionKey,
  }: ConnectMailboxAccountInput,
): Promise<string> => {
  const credentials = {
    userId,
    providerAccountId,
    accessTokenEncrypted: encryptToken(tokens.accessToken, encryptionKey),
    refreshTokenEncrypted: encryptToken(tokens.refreshToken, encryptionKey),
    tokenExpiresAt: tokens.expiresAt,
  };

  const [row] = await db
    .insert(mailboxAccounts)
    .values({
      tenantId,
      provider,
      emailAddress: emailAddress.toLowerCase(),
      ...credentials,
    })
    .onConflictDoUpdate({
      target: [
        mailboxAccounts.tenantId,
        mailboxAccounts.provider,
        mailboxAccounts.emailAddress,
      ],
      // `connectedAt` and `syncCursor` stay as they were: mail that arrived
      // before a re-consent is still mail this mailbox is meant to process.
      // `$onUpdate` does not fire on a conflict path, so the stamp is explicit.
      set: { ...credentials, updatedAt: new Date() },
    })
    .returning({ id: mailboxAccounts.id });

  if (!row) throw new Error(`Failed to connect the ${provider} mailbox.`);
  return row.id;
};
