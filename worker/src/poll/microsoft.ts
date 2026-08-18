// Polling one connected Microsoft 365 mailbox (context.md §8): renew the access
// token if it is about to die and ask Graph what is new since the stored cursor.
// Moving that cursor on is the caller's `commit`, once the mail is stored.
// Reading mail itself lives in the shared Graph client.

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mailboxAccounts } from "@correu-agent/shared/db/schema";
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
import type { MailboxPoll } from "./types";

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
 * New mail in one Microsoft mailbox since its last poll, plus the `commit` that
 * moves the cursor on once that mail is stored.
 *
 * The cursor is not written here: a poll that dies mid-flight has to repeat
 * itself rather than skip mail, and the same message reaching the pipeline twice
 * is settled by the uniqueness of `(thread, provider message id)` when it is
 * persisted. Renewed tokens are the exception — Entra rotates the refresh token
 * away on every use, so the new pair is stored as soon as it is minted or the
 * mailbox is locked out.
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
): Promise<MailboxPoll> => {
  const polledAt = now();
  const accessToken = await resolveMicrosoftAccessToken(db, account, {
    clientId,
    clientSecret,
    tenant,
    encryptionKey,
    fetch,
    now: () => polledAt,
  });

  const sync = await fetchMicrosoftNewMessages({
    accessToken,
    deltaLink: account.syncCursor,
    // Not the last poll: mail older than the connection is never this
    // product's business, however far back the cursor reaches (context.md §4).
    since: account.connectedAt,
    fetch,
  });

  return {
    messages: sync.messages,
    commit: () =>
      updateAccount(db, account, {
        syncCursor: sync.deltaLink,
        lastPolledAt: polledAt,
      }),
  };
};

/**
 * The stored access token while it lasts, a freshly minted one after that.
 * Entra rotates the refresh token away on every use, so the new pair is stored
 * as soon as it is minted or the mailbox is locked out.
 *
 * Exported because reading a mailbox is not the only thing the worker needs a
 * token for: an auto-reply is sent from the same mailbox, with the same grant.
 */
export const resolveMicrosoftAccessToken = async <
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
): Promise<string> => {
  if (!account.refreshTokenEncrypted) {
    throw new Error(
      `Mailbox ${account.emailAddress} has no refresh token — it has to be reconnected.`,
    );
  }

  const at = now();
  const stillValid =
    account.accessTokenEncrypted &&
    account.tokenExpiresAt &&
    account.tokenExpiresAt.getTime() - at.getTime() > EXPIRY_SKEW_MS
      ? account.accessTokenEncrypted
      : null;

  if (stillValid) return decryptToken(stillValid, encryptionKey);

  const refreshed: MicrosoftTokenSet = await refreshMicrosoftAccessToken({
    clientId,
    clientSecret,
    tenant,
    refreshToken: decryptToken(account.refreshTokenEncrypted, encryptionKey),
    now: at,
    fetch,
  });
  await updateAccount(db, account, {
    accessTokenEncrypted: encryptToken(refreshed.accessToken, encryptionKey),
    refreshTokenEncrypted: encryptToken(refreshed.refreshToken, encryptionKey),
    tokenExpiresAt: refreshed.expiresAt,
  });

  return refreshed.accessToken;
};

/** Every write this poll makes is to its own mailbox row, and to its tenant's alone. */
const updateAccount = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  account: PollableMailboxAccount,
  values: Partial<typeof mailboxAccounts.$inferInsert>,
): Promise<void> => {
  await db
    .update(mailboxAccounts)
    .set(values)
    .where(
      and(
        eq(mailboxAccounts.id, account.id),
        eq(mailboxAccounts.tenantId, account.tenantId),
      ),
    );
};
