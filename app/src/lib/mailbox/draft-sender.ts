// El client de correu pel qual surt la resposta d'un esborrany aprovat
// (context.md §2): el tauler no parla mai amb Gmail ni amb Graph directament,
// sinó amb el client tipat de `shared/` de la bústia del fil de l'esborrany.
//
// L'única feina d'aquí és tenir-ne un token d'accés viu: el desat mentre duri i
// un de renovat quan no, desat xifrat com tots (context.md §7).

import { and, eq } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drafts, mailboxAccounts, threads } from "@correu-agent/shared/db/schema";
import type { MailProvider } from "@correu-agent/shared/db/schema";
import {
  createGmailSender,
  loadGoogleOAuthCredentials,
  refreshGoogleAccessToken,
  type MailSenderClient,
} from "@correu-agent/shared/mail";
import {
  createMicrosoftSender,
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

export interface DraftSenderOptions {
  tenantId: string;
  draftId: string;
}

export interface DraftSenderDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

type Database<
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> = PgDatabase<TResult, TFullSchema, TSchema>;

interface SenderMailbox {
  id: string;
  provider: MailProvider;
  emailAddress: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
}

/**
 * The client the reply of `draftId` leaves through. The mailbox is reached from
 * the draft itself rather than from anything the form said: a submission that
 * paired someone else's draft with a mailbox of its choosing would otherwise
 * send mail out of the wrong address.
 *
 * Throws rather than answering null: every caller is about to send an approved
 * draft, and a missing mailbox is nothing the dashboard can carry on without.
 */
export const createDraftSender = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Database<TResult, TFullSchema, TSchema>,
  { tenantId, draftId }: DraftSenderOptions,
  { env = process.env, fetch = globalThis.fetch, now = () => new Date() }: DraftSenderDeps = {},
): Promise<MailSenderClient> => {
  const [mailbox] = await db
    .select({
      id: mailboxAccounts.id,
      provider: mailboxAccounts.provider,
      emailAddress: mailboxAccounts.emailAddress,
      accessTokenEncrypted: mailboxAccounts.accessTokenEncrypted,
      refreshTokenEncrypted: mailboxAccounts.refreshTokenEncrypted,
      tokenExpiresAt: mailboxAccounts.tokenExpiresAt,
    })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxAccounts, eq(mailboxAccounts.id, threads.mailboxAccountId))
    // Tenant-scoped: the draft id comes off a form, and a mailbox is the last
    // thing that may be reached across tenants.
    .where(and(eq(drafts.id, draftId), eq(drafts.tenantId, tenantId)))
    .limit(1);

  if (!mailbox) {
    throw new Error(`Draft ${draftId} has no connected mailbox to send from.`);
  }

  const encryptionKey = loadTokenEncryptionKey(env);
  const sendingAt = now();
  const stillValid =
    mailbox.accessTokenEncrypted &&
    (mailbox.tokenExpiresAt?.getTime() ?? 0) - EXPIRY_SKEW_MS >
      sendingAt.getTime()
      ? decryptToken(mailbox.accessTokenEncrypted, encryptionKey)
      : null;

  switch (mailbox.provider) {
    case "google":
      return createGmailSender(
        stillValid ??
          (await renewGoogleToken(db, mailbox, { tenantId, encryptionKey, env })),
      );
    case "microsoft":
      return createMicrosoftSender({
        accessToken:
          stillValid ??
          (await renewMicrosoftToken(db, mailbox, {
            tenantId,
            encryptionKey,
            env,
            fetch,
            sendingAt,
          })),
        fetch,
      });
  }
};

/** A mailbox that cannot mint a token has to be reconnected before it sends. */
const refreshTokenOf = (
  { refreshTokenEncrypted, emailAddress }: SenderMailbox,
  encryptionKey: Buffer,
): string => {
  if (!refreshTokenEncrypted) {
    throw new Error(
      `Mailbox ${emailAddress} has no refresh token: it has to be reconnected before it can send.`,
    );
  }
  return decryptToken(refreshTokenEncrypted, encryptionKey);
};

/** Every write here is to the thread's own mailbox row, and to its tenant's alone. */
const storeTokens = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Database<TResult, TFullSchema, TSchema>,
  mailbox: SenderMailbox,
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
  mailbox: SenderMailbox,
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

  // Stored so the next send — or the poll two minutes from now — does not have
  // to mint another one (context.md §7, §8).
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
  if (!value) throw new Error(`${name} is not set — cannot send a reply.`);
  return value;
};

const renewMicrosoftToken = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Database<TResult, TFullSchema, TSchema>,
  mailbox: SenderMailbox,
  {
    tenantId,
    encryptionKey,
    env,
    fetch,
    sendingAt,
  }: {
    tenantId: string;
    encryptionKey: Buffer;
    env: Record<string, string | undefined>;
    fetch: typeof globalThis.fetch;
    sendingAt: Date;
  },
): Promise<string> => {
  const refreshed = await refreshMicrosoftAccessToken({
    clientId: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_ID"),
    clientSecret: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_SECRET"),
    tenant: microsoftTenantFromIssuer(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER),
    refreshToken: refreshTokenOf(mailbox, encryptionKey),
    now: sendingAt,
    fetch,
  });

  // Entra rotates the refresh token away on use, so the pair is stored whole:
  // keeping the retired one would lock the mailbox out of the next send.
  await storeTokens(db, mailbox, tenantId, {
    accessTokenEncrypted: encryptToken(refreshed.accessToken, encryptionKey),
    refreshTokenEncrypted: encryptToken(refreshed.refreshToken, encryptionKey),
    tokenExpiresAt: refreshed.expiresAt,
  });

  return refreshed.accessToken;
};
