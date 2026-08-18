import type { WorkHandler } from "pg-boss";
import type { GmailPollOutcome, GmailPollTarget } from "../mailbox/gmail-poll";

/** Queue that drives the 2-minute mailbox polling cadence (context.md §8). */
export const MAILBOX_POLL_QUEUE = "mailbox-poll";

/** Payload of a `mailbox-poll` job: which connected mailbox to poll, for which tenant. */
export type MailboxPollJobData = GmailPollTarget;

/** A mailbox account polled in a batch — same shape as the job payload. */
export type MailboxPollTarget = GmailPollTarget;

/**
 * What one mailbox's poll found. Only the count: pg-boss keeps a job's result
 * in its own table, and the mail bodies belong on `messages`, under the 90-day
 * retention window (context.md §7).
 */
export type MailboxPollOutcome = MailboxPollTarget & {
  newMessages: number;
  cursor: string;
};

export type MailboxPollResult = {
  polled: MailboxPollOutcome[];
};

export type MailboxPollDependencies = {
  pollGmailMailbox: (
    target: MailboxPollTarget,
  ) => Promise<GmailPollOutcome | null>;
};

const targetKey = ({ tenantId, mailboxAccountId }: MailboxPollTarget): string =>
  `${tenantId}:${mailboxAccountId}`;

/**
 * Polls the mailbox accounts in the batch and reports what each one found.
 *
 * A batch can contain the same mailbox account more than once (a poll job queued
 * while the previous one was still waiting), so targets are de-duplicated: polling
 * the same mailbox twice in one batch would only burn provider quota.
 *
 * Persisting the mail it brings back is the next step of the pipeline, so for
 * now the messages only travel inside the outcome the poll returns.
 */
export const createMailboxPollHandler = ({
  pollGmailMailbox,
}: MailboxPollDependencies): WorkHandler<
  MailboxPollJobData,
  MailboxPollResult
> => async (jobs) => {
  const targets = new Map<string, MailboxPollTarget>();

  for (const { data } of jobs) {
    const target: MailboxPollTarget = {
      tenantId: data.tenantId,
      mailboxAccountId: data.mailboxAccountId,
    };
    targets.set(targetKey(target), target);
  }

  const polled: MailboxPollOutcome[] = [];
  for (const target of targets.values()) {
    // Mailboxes are polled one after another rather than all at once: the PoC
    // has a handful of them, and a burst of parallel calls is what provider
    // rate limits punish.
    const outcome = await pollGmailMailbox(target);
    // Null means the mailbox was disconnected after the job was queued.
    if (!outcome) continue;

    polled.push({
      tenantId: outcome.tenantId,
      mailboxAccountId: outcome.mailboxAccountId,
      newMessages: outcome.messages.length,
      cursor: outcome.cursor,
    });
  }

  return { polled };
};
