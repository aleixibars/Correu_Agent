// Which mailboxes the 2-minute poll looks at, and the columns a poll needs
// (context.md §8). Kept apart from the provider clients so the scheduler and
// the job handler agree on one definition of "pollable".

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mailboxAccounts, type MailProvider } from "@correu-agent/shared/db/schema";

/** Providers this worker has a poller for; Gmail joins the list with its own. */
export const POLLED_PROVIDERS = [
  "microsoft",
] as const satisfies readonly MailProvider[];

export interface PollableMailboxAccount {
  id: string;
  tenantId: string;
  provider: MailProvider;
  emailAddress: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
  /** Gmail historyId / Graph delta link — where this poll resumes from. */
  syncCursor: string | null;
  connectedAt: Date;
}

const POLLABLE_COLUMNS = {
  id: mailboxAccounts.id,
  tenantId: mailboxAccounts.tenantId,
  provider: mailboxAccounts.provider,
  emailAddress: mailboxAccounts.emailAddress,
  accessTokenEncrypted: mailboxAccounts.accessTokenEncrypted,
  refreshTokenEncrypted: mailboxAccounts.refreshTokenEncrypted,
  tokenExpiresAt: mailboxAccounts.tokenExpiresAt,
  syncCursor: mailboxAccounts.syncCursor,
  connectedAt: mailboxAccounts.connectedAt,
};

type Database<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> = PgDatabase<T, TSchema>;

/**
 * The mailboxes worth queueing a poll for. A mailbox with no refresh token
 * cannot be polled at all — its grant was revoked or never stored — so it is
 * left out here rather than producing a failing job every 2 minutes.
 */
export const listPollableMailboxAccounts = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: Database<T, TSchema>,
): Promise<{ id: string; tenantId: string }[]> =>
  db
    .select({ id: mailboxAccounts.id, tenantId: mailboxAccounts.tenantId })
    .from(mailboxAccounts)
    .where(
      and(
        inArray(mailboxAccounts.provider, [...POLLED_PROVIDERS]),
        isNotNull(mailboxAccounts.refreshTokenEncrypted),
      ),
    );

/**
 * The mailbox a queued job names, re-read at poll time: the tokens and the
 * cursor move between queueing and working, and the job payload must not be
 * trusted to still describe them.
 */
export const loadPollableMailboxAccount = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: Database<T, TSchema>,
  { tenantId, mailboxAccountId }: { tenantId: string; mailboxAccountId: string },
): Promise<PollableMailboxAccount | undefined> => {
  const [account] = await db
    .select(POLLABLE_COLUMNS)
    .from(mailboxAccounts)
    .where(
      and(
        eq(mailboxAccounts.id, mailboxAccountId),
        // Tenant-scoped on purpose: a job payload never reaches across tenants.
        eq(mailboxAccounts.tenantId, tenantId),
      ),
    )
    .limit(1);

  return account;
};
