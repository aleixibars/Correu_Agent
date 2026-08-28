// El client de correu pel qual surt la resposta d'un esborrany aprovat
// (context.md §2): el tauler no parla mai amb Gmail ni amb Graph directament,
// sinó amb el client tipat de `shared/` de la bústia del fil de l'esborrany.
//
// El token viu amb què s'hi arriba el dona `./access-token`, que és el mateix
// que fa servir la ruta que serveix un adjunt.

import { and, eq } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drafts, mailboxAccounts, threads } from "@correu-agent/shared/db/schema";
import {
  createGmailSender,
  type MailSenderClient,
} from "@correu-agent/shared/mail";
import { createMicrosoftSender } from "@correu-agent/shared/mailbox";
import { mailboxAccessToken, type AccessTokenDeps } from "./access-token";

export interface DraftSenderOptions {
  tenantId: string;
  draftId: string;
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
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  { tenantId, draftId }: DraftSenderOptions,
  deps: AccessTokenDeps = {},
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

  const accessToken = await mailboxAccessToken(db, mailbox, { tenantId }, deps);

  switch (mailbox.provider) {
    case "google":
      return createGmailSender(accessToken);
    case "microsoft":
      return createMicrosoftSender({
        accessToken,
        fetch: deps.fetch ?? globalThis.fetch,
      });
  }
};
