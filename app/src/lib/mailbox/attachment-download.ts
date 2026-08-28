// Els bytes d'un adjunt, demanats al proveïdor just quan el tauler els serveix
// (issue #78). El producte no en desa cap còpia (context.md §7): d'aquest fitxer
// només n'hi ha les metadades a la base de dades, i el que hi ha aquí és el
// camí d'anada i tornada al proveïdor amb el token viu de la bústia.

import { and, eq } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  mailboxAccounts,
  messageAttachments,
  messages,
  threads,
} from "@correu-agent/shared/db/schema";
import { createGmailAttachmentReader } from "@correu-agent/shared/mail";
import type { MailAttachmentClient } from "@correu-agent/shared/mail";
import { createMicrosoftAttachmentReader } from "@correu-agent/shared/mailbox";
import { normaliseMimeType } from "../attachments/preview";
import { isUuid } from "../uuid";
import {
  mailboxAccessToken,
  type AccessTokenDeps,
  type TokenMailbox,
} from "./access-token";

export interface AttachmentDownloadOptions {
  tenantId: string;
  attachmentId: string;
}

/** One attachment on its way to the browser; the bytes are never written down. */
export interface AttachmentDownload {
  filename: string;
  /** What the sender called it, without the parameters; null when it said nothing. */
  mimeType: string | null;
  bytes: Uint8Array;
}

/**
 * The attachment `attachmentId` names, or null when the tenant has no such
 * attachment — or when the provider no longer holds the mail it came with.
 *
 * Null and not an error for both: an attachment id is a URL segment, so another
 * tenant's file and a deleted mail have to read the same way a mistyped link
 * does, as nothing to serve.
 */
export const downloadAttachment = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  { tenantId, attachmentId }: AttachmentDownloadOptions,
  deps: AccessTokenDeps = {},
): Promise<AttachmentDownload | null> => {
  if (!isUuid(attachmentId)) return null;

  const [row] = await db
    .select({
      filename: messageAttachments.filename,
      mimeType: messageAttachments.mimeType,
      providerAttachmentId: messageAttachments.providerAttachmentId,
      providerMessageId: messages.providerMessageId,
      mailboxId: mailboxAccounts.id,
      provider: mailboxAccounts.provider,
      emailAddress: mailboxAccounts.emailAddress,
      accessTokenEncrypted: mailboxAccounts.accessTokenEncrypted,
      refreshTokenEncrypted: mailboxAccounts.refreshTokenEncrypted,
      tokenExpiresAt: mailboxAccounts.tokenExpiresAt,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxAccounts, eq(mailboxAccounts.id, threads.mailboxAccountId))
    // Tenant-scoped: the id arrives in the URL, and a mailbox is the last thing
    // that may be reached across tenants.
    .where(
      and(
        eq(messageAttachments.id, attachmentId),
        eq(messageAttachments.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!row) return null;

  const mailbox: TokenMailbox = {
    id: row.mailboxId,
    provider: row.provider,
    emailAddress: row.emailAddress,
    accessTokenEncrypted: row.accessTokenEncrypted,
    refreshTokenEncrypted: row.refreshTokenEncrypted,
    tokenExpiresAt: row.tokenExpiresAt,
  };
  const accessToken = await mailboxAccessToken(db, mailbox, { tenantId }, deps);

  const reader: MailAttachmentClient =
    mailbox.provider === "google"
      ? createGmailAttachmentReader(accessToken)
      : createMicrosoftAttachmentReader({
          accessToken,
          fetch: deps.fetch ?? globalThis.fetch,
        });

  const bytes = await reader.fetchAttachment({
    providerMessageId: row.providerMessageId,
    providerAttachmentId: row.providerAttachmentId,
  });
  if (!bytes) return null;

  return {
    filename: row.filename,
    mimeType: normaliseMimeType(row.mimeType),
    bytes,
  };
};
