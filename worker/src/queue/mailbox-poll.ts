import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { WorkHandler } from "pg-boss";
import type { MailboxMessageSummary } from "@correu-agent/shared/mailbox";
import { loadPollableMailboxAccount } from "../poll/accounts";
import { pollGmailMailbox, type GmailPollConfig } from "../poll/gmail";
import { pollMicrosoftMailbox, type MicrosoftPollConfig } from "../poll/microsoft";

/** Queue that drives the 2-minute mailbox polling cadence (context.md §8). */
export const MAILBOX_POLL_QUEUE = "mailbox-poll";

/** Payload of a `mailbox-poll` job: which connected mailbox to poll, for which tenant. */
export type MailboxPollJobData = {
  tenantId: string;
  mailboxAccountId: string;
};

/** A mailbox account polled in a batch — same shape as the job payload. */
export type MailboxPollTarget = MailboxPollJobData;

/** A message the poll found, kept next to the mailbox it belongs to. */
export type PolledMailboxMessage = MailboxPollTarget & {
  message: MailboxMessageSummary;
};

export type FailedMailboxPoll = MailboxPollTarget & { error: string };

export type MailboxPollResult = {
  polled: MailboxPollTarget[];
  messages: PolledMailboxMessage[];
  failed: FailedMailboxPoll[];
};

export interface MailboxPollDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
  google: GmailPollConfig;
  microsoft: MicrosoftPollConfig;
}

const targetKey = ({ tenantId, mailboxAccountId }: MailboxPollTarget): string =>
  `${tenantId}:${mailboxAccountId}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Polls every mailbox account named in the batch and reports the new mail it
 * found; persisting those messages and triaging them is the next stage of the
 * pipeline.
 *
 * A batch can contain the same mailbox account more than once (a poll job queued
 * while the previous one was still waiting), so targets are de-duplicated: polling
 * the same mailbox twice in one batch would only burn provider quota.
 */
export const createMailboxPollHandler = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  db,
  google,
  microsoft,
}: MailboxPollDeps<T, TSchema>): WorkHandler<
  MailboxPollJobData,
  MailboxPollResult
> => {
  /** `null` when there is no mailbox to poll, as opposed to no new mail in one. */
  const pollOne = async (
    target: MailboxPollTarget,
  ): Promise<MailboxMessageSummary[] | null> => {
    const account = await loadPollableMailboxAccount(db, target);
    // Disconnected between queueing and working: nothing to poll, nothing wrong.
    if (!account) return null;

    switch (account.provider) {
      case "google":
        return pollGmailMailbox(db, account, google);
      case "microsoft":
        return pollMicrosoftMailbox(db, account, microsoft);
      default:
        throw new Error(
          `No poller for a ${account.provider} mailbox (${account.emailAddress}).`,
        );
    }
  };

  return async (jobs) => {
    const targets = new Map<string, MailboxPollTarget>();
    for (const { data } of jobs) {
      const target: MailboxPollTarget = {
        tenantId: data.tenantId,
        mailboxAccountId: data.mailboxAccountId,
      };
      targets.set(targetKey(target), target);
    }

    const polled: MailboxPollTarget[] = [];
    const messages: PolledMailboxMessage[] = [];
    const failed: FailedMailboxPoll[] = [];

    // One mailbox at a time: a batch is small, and a failing mailbox must not
    // take the others down with it.
    for (const target of targets.values()) {
      try {
        const found = await pollOne(target);
        if (!found) continue;
        polled.push(target);
        messages.push(...found.map((message) => ({ ...target, message })));
      } catch (error) {
        // One mailbox with a revoked grant or an exhausted quota must not hide
        // the rest of the batch, but it must not disappear either: pg-boss keeps
        // nothing but the job result, so the failure is both logged and reported.
        console.error(`Polling mailbox ${target.mailboxAccountId} failed:`, error);
        failed.push({ ...target, error: errorMessage(error) });
      }
    }

    // Nothing polled at all is a batch worth retrying — reporting success would
    // hide, say, an expired client secret behind an empty result.
    if (polled.length === 0 && failed.length > 0) {
      throw new Error(
        `Every mailbox in the batch failed to poll: ${failed
          .map(({ error }) => error)
          .join("; ")}`,
      );
    }

    return { polled, messages, failed };
  };
};
