import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { WorkHandler } from "pg-boss";
import {
  persistPolledMessages,
  type PersistedThread,
} from "@correu-agent/shared/mailbox";
import {
  loadPollableMailboxAccount,
  type PollableMailboxAccount,
} from "../poll/accounts";
import { pollGmailMailbox, type GmailPollConfig } from "../poll/gmail";
import { pollMicrosoftMailbox, type MicrosoftPollConfig } from "../poll/microsoft";
import type { MailboxPoll } from "../poll/types";
import type { ThreadTriageJobData } from "./thread-triage";

/** Queue that drives the 2-minute mailbox polling cadence (context.md §8). */
export const MAILBOX_POLL_QUEUE = "mailbox-poll";

/** Payload of a `mailbox-poll` job: which connected mailbox to poll, for which tenant. */
export type MailboxPollJobData = {
  tenantId: string;
  mailboxAccountId: string;
};

/** A mailbox account polled in a batch — same shape as the job payload. */
export type MailboxPollTarget = MailboxPollJobData;

/** A thread the poll wrote to, kept next to the mailbox it belongs to. */
export type PolledMailboxThread = MailboxPollTarget & {
  threadId: string;
  providerThreadId: string;
  /** False for a thread that already has a category: a reply never re-triages it (context.md §4). */
  needsTriage: boolean;
  /** How much mail this poll really stored — 0 when the provider repeated itself. */
  newMessages: number;
};

export type FailedMailboxPoll = MailboxPollTarget & { error: string };

export type MailboxPollResult = {
  polled: MailboxPollTarget[];
  threads: PolledMailboxThread[];
  failed: FailedMailboxPoll[];
};

/**
 * Queues the immediate triage of a thread the poll just wrote (context.md §8):
 * the same job and singleton key the 2-minute schedule (`triage/schedule.ts`)
 * would queue on its next tick, sent right away so fresh mail does not wait for
 * that clock — the schedule itself keeps running as the safety net for anything
 * this misses.
 */
export type QueueThreadTriage = (target: ThreadTriageJobData) => Promise<unknown>;

export interface MailboxPollDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
  google: GmailPollConfig;
  microsoft: MicrosoftPollConfig;
  queueThreadTriage: QueueThreadTriage;
}

const targetKey = ({ tenantId, mailboxAccountId }: MailboxPollTarget): string =>
  `${tenantId}:${mailboxAccountId}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Polls every mailbox account named in the batch, stores what it found as
 * threads and messages, and reports the threads that were written to; triaging
 * them is the next stage of the pipeline.
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
  queueThreadTriage,
}: MailboxPollDeps<T, TSchema>): WorkHandler<
  MailboxPollJobData,
  MailboxPollResult
> => {
  const pollProvider = (
    account: PollableMailboxAccount,
  ): Promise<MailboxPoll> => {
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

  /** `null` when there is no mailbox to poll, as opposed to no new mail in one. */
  const pollOne = async (
    target: MailboxPollTarget,
  ): Promise<PersistedThread[] | null> => {
    const account = await loadPollableMailboxAccount(db, target);
    // Disconnected between queueing and working: nothing to poll, nothing wrong.
    if (!account) return null;

    const { messages, commit } = await pollProvider(account);
    const persisted = await persistPolledMessages(db, {
      tenantId: target.tenantId,
      mailboxAccountId: target.mailboxAccountId,
      messages,
    });
    // Only now: the cursor is the mailbox's memory of what it has already been
    // shown, so moving it before the rows are written would lose the mail of a
    // poll that died in between — the provider never offers it a second time.
    await commit();

    return persisted;
  };

  /**
   * Queues triage for the threads that need it, right after the poll wrote
   * them. A failure here (the queue table unreachable, say) must not turn a
   * successful poll into a failed job — `triage/schedule.ts`'s own 2-minute
   * tick will still pick the thread up, just later than intended.
   */
  const queueImmediateTriage = async (
    polledThreads: PolledMailboxThread[],
  ): Promise<void> => {
    for (const thread of polledThreads) {
      if (!thread.needsTriage) continue;
      try {
        await queueThreadTriage({
          tenantId: thread.tenantId,
          threadId: thread.threadId,
        });
      } catch (error) {
        console.error(
          `Queuing immediate triage for thread ${thread.threadId} failed:`,
          error,
        );
      }
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
    const threads: PolledMailboxThread[] = [];
    const failed: FailedMailboxPoll[] = [];

    // One mailbox at a time: a batch is small, and a failing mailbox must not
    // take the others down with it.
    for (const target of targets.values()) {
      try {
        const found = await pollOne(target);
        if (!found) continue;
        polled.push(target);
        const newThreads = found.map((thread) => ({
          ...target,
          threadId: thread.threadId,
          providerThreadId: thread.providerThreadId,
          needsTriage: thread.triagedAt === null,
          newMessages: thread.newProviderMessageIds.length,
        }));
        threads.push(...newThreads);
        await queueImmediateTriage(newThreads);
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

    return { polled, threads, failed };
  };
};
