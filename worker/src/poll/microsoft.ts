// Polling one connected Microsoft 365 mailbox (context.md §8): renew the access
// token if it is about to die, ask Graph what is new since the stored cursor,
// and move the cursor on. Reading mail itself lives in the shared Graph client.

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mailboxAccounts } from "@correu-agent/shared/db/schema";
import type { ProviderMessage } from "@correu-agent/shared/mail";
import {
  fetchMicrosoftNewMessages,
  microsoftTenantFromIssuer,
  refreshMicrosoftAccessToken,
  type MicrosoftTokenSet,
} from "@correu-agent/shared/mailbox";
import {
  decryptToken,
  encryptToken,
  loadTokenEncryptionKey,
} from "@correu-agent/shared/token-encryption";
import type { PollableMailboxAccount } from "./accounts";

/**
 * A token valid for less than this is treated as expired: one that dies halfway
 * through a poll costs the whole run, and a refresh is cheap.
 */
const EXPIRY_SKEW_MS = 60_000;

export interface MicrosoftPollConfig {
  clientId: string;
  clientSecret: string;
  /** Azure directory the mailbox belongs to; unset means the multi-directory endpoint. */
  tenant?: string;
  encryptionKey: Buffer;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

const requireEnv = (
  env: Record<string, string | undefined>,
  name: string,
): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — cannot poll a mailbox.`);
  return value;
};

/**
 * The worker polls with the same Entra app registration the dashboard connects
 * mailboxes with — one app, one consent, one set of secrets.
 */
export const loadMicrosoftPollConfig = (
  env: Record<string, string | undefined> = process.env,
): MicrosoftPollConfig => ({
  clientId: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_ID"),
  clientSecret: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_SECRET"),
  tenant: microsoftTenantFromIssuer(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER),
  encryptionKey: loadTokenEncryptionKey(env),
});

/**
 * New mail in one Microsoft mailbox since its last poll.
 *
 * The cursor is written after Graph answered, so a poll that dies mid-flight
 * repeats itself rather than skipping mail; the same message reaching the
 * pipeline twice is settled by the uniqueness of `(thread, provider message id)`
 * when it is persisted.
 */
export const pollMicrosoftMailbox = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  account: PollableMailboxAccount,
  {
    clientId,
    clientSecret,
    tenant,
    encryptionKey,
    fetch = globalThis.fetch,
    now = () => new Date(),
  }: MicrosoftPollConfig,
): Promise<ProviderMessage[]> => {
  if (!account.refreshTokenEncrypted) {
    throw new Error(
      `Mailbox ${account.emailAddress} has no refresh token — it has to be reconnected.`,
    );
  }

  const polledAt = now();
  const stillValid =
    account.accessTokenEncrypted &&
    account.tokenExpiresAt &&
    account.tokenExpiresAt.getTime() - polledAt.getTime() > EXPIRY_SKEW_MS
      ? account.accessTokenEncrypted
      : null;

  let refreshed: MicrosoftTokenSet | null = null;
  let accessToken: string;
  if (stillValid) {
    accessToken = decryptToken(stillValid, encryptionKey);
  } else {
    refreshed = await refreshMicrosoftAccessToken({
      clientId,
      clientSecret,
      tenant,
      refreshToken: decryptToken(account.refreshTokenEncrypted, encryptionKey),
      now: polledAt,
      fetch,
    });
    accessToken = refreshed.accessToken;
  }

  const sync = await fetchMicrosoftNewMessages({
    accessToken,
    deltaLink: account.syncCursor,
    // Not the last poll: mail older than the connection is never this
    // product's business, however far back the cursor reaches (context.md §4).
    since: account.connectedAt,
    fetch,
  });

  await db
    .update(mailboxAccounts)
    .set({
      syncCursor: sync.deltaLink,
      lastPolledAt: polledAt,
      ...(refreshed
        ? {
            accessTokenEncrypted: encryptToken(
              refreshed.accessToken,
              encryptionKey,
            ),
            refreshTokenEncrypted: encryptToken(
              refreshed.refreshToken,
              encryptionKey,
            ),
            tokenExpiresAt: refreshed.expiresAt,
          }
        : {}),
    })
    .where(
      and(
        eq(mailboxAccounts.id, account.id),
        eq(mailboxAccounts.tenantId, account.tenantId),
      ),
    );

  return sync.messages;
};
