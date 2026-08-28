// Un token d'accés viu per a la bústia d'un tenant: el desat mentre duri i un
// de renovat quan no, desat xifrat com tots (context.md §7).
//
// Compartit per tot el que el tauler fa contra el proveïdor — enviar la
// resposta d'un esborrany (`draft-sender.ts`) i servir un adjunt
// (`attachment-download.ts`) — perquè renovar un token és la mateixa feina
// delicada les dues vegades: Entra en rota el de refresc en fer-lo servir, i
// desar-ne només la meitat deixaria la bústia fora fins a reconnectar-la.

import { and, eq } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mailboxAccounts } from "@correu-agent/shared/db/schema";
import type { MailProvider } from "@correu-agent/shared/db/schema";
import {
  loadGoogleOAuthCredentials,
  refreshGoogleAccessToken,
} from "@correu-agent/shared/mail";
import {
  microsoftTenantFromIssuer,
  refreshMicrosoftAccessToken,
} from "@correu-agent/shared/mailbox";
import {
  decryptToken,
  encryptToken,
  loadTokenEncryptionKey,
} from "@correu-agent/shared/token-encryption";

/**
 * A token about to expire is as good as expired: the provider takes seconds to
 * answer, and a send that dies halfway is the one failure that cannot be
 * retried without risking a second copy of the mail.
 */
const EXPIRY_SKEW_MS = 60_000;

/** The mailbox columns a token is minted from; every caller selects exactly these. */
export interface TokenMailbox {
  id: string;
  provider: MailProvider;
  emailAddress: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
}

export interface AccessTokenDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

type Database<
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgDatabase<TResult, TFullSchema, TSchema>;

/**
 * The access token of `mailbox`, minting a new one when the stored one is gone
 * or about to be. The refreshed pair is written back to the mailbox row, so the
 * next request — or the poll two minutes from now — does not mint another
 * (context.md §7, §8).
 */
export const mailboxAccessToken = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Database<TResult, TFullSchema, TSchema>,
  mailbox: TokenMailbox,
  { tenantId }: { tenantId: string },
  {
    env = process.env,
    fetch = globalThis.fetch,
    now = () => new Date(),
  }: AccessTokenDeps = {},
): Promise<string> => {
  const encryptionKey = loadTokenEncryptionKey(env);
  const askedAt = now();
  const stillValid =
    mailbox.accessTokenEncrypted &&
    (mailbox.tokenExpiresAt?.getTime() ?? 0) - EXPIRY_SKEW_MS > askedAt.getTime()
      ? decryptToken(mailbox.accessTokenEncrypted, encryptionKey)
      : null;
  if (stillValid) return stillValid;

  switch (mailbox.provider) {
    case "google":
      return renewGoogleToken(db, mailbox, { tenantId, encryptionKey, env });
    case "microsoft":
      return renewMicrosoftToken(db, mailbox, {
        tenantId,
        encryptionKey,
        env,
        fetch,
        askedAt,
      });
  }
};

/** A mailbox that cannot mint a token has to be reconnected before it is used. */
const refreshTokenOf = (
  { refreshTokenEncrypted, emailAddress }: TokenMailbox,
  encryptionKey: Buffer,
): string => {
  if (!refreshTokenEncrypted) {
    throw new Error(
      `Mailbox ${emailAddress} has no refresh token: it has to be reconnected before it can send.`,
    );
  }
  return decryptToken(refreshTokenEncrypted, encryptionKey);
};

/** Every write here is to the given mailbox row, and to its tenant's alone. */
const storeTokens = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Database<TResult, TFullSchema, TSchema>,
  mailbox: TokenMailbox,
  tenantId: string,
  values: Partial<typeof mailboxAccounts.$inferInsert>,
): Promise<void> => {
  await db
    .update(mailboxAccounts)
    .set(values)
    .where(
      and(
        eq(mailboxAccounts.id, mailbox.id),
        eq(mailboxAccounts.tenantId, tenantId),
      ),
    );
};

const renewGoogleToken = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Database<TResult, TFullSchema, TSchema>,
  mailbox: TokenMailbox,
  {
    tenantId,
    encryptionKey,
    env,
  }: {
    tenantId: string;
    encryptionKey: Buffer;
    env: Record<string, string | undefined>;
  },
): Promise<string> => {
  const refreshed = await refreshGoogleAccessToken(
    loadGoogleOAuthCredentials(env),
    refreshTokenOf(mailbox, encryptionKey),
  );

  await storeTokens(db, mailbox, tenantId, {
    accessTokenEncrypted: encryptToken(refreshed.accessToken, encryptionKey),
    tokenExpiresAt: refreshed.expiresAt,
  });

  return refreshed.accessToken;
};

const requireEnv = (
  env: Record<string, string | undefined>,
  name: string,
): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — cannot reach the mailbox.`);
  return value;
};

const renewMicrosoftToken = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Database<TResult, TFullSchema, TSchema>,
  mailbox: TokenMailbox,
  {
    tenantId,
    encryptionKey,
    env,
    fetch,
    askedAt,
  }: {
    tenantId: string;
    encryptionKey: Buffer;
    env: Record<string, string | undefined>;
    fetch: typeof globalThis.fetch;
    askedAt: Date;
  },
): Promise<string> => {
  const refreshed = await refreshMicrosoftAccessToken({
    clientId: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_ID"),
    clientSecret: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_SECRET"),
    tenant: microsoftTenantFromIssuer(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER),
    refreshToken: refreshTokenOf(mailbox, encryptionKey),
    now: askedAt,
    fetch,
  });

  // Entra rotates the refresh token away on use, so the pair is stored whole:
  // keeping the retired one would lock the mailbox out of the next request.
  await storeTokens(db, mailbox, tenantId, {
    accessTokenEncrypted: encryptToken(refreshed.accessToken, encryptionKey),
    refreshTokenEncrypted: encryptToken(refreshed.refreshToken, encryptionKey),
    tokenExpiresAt: refreshed.expiresAt,
  });

  return refreshed.accessToken;
};
