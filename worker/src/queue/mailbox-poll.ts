import type { WorkHandler } from "pg-boss";

/** Queue that drives the 2-minute mailbox polling cadence (context.md §8). */
export const MAILBOX_POLL_QUEUE = "mailbox-poll";

/** Payload of a `mailbox-poll` job: which connected mailbox to poll, for which tenant. */
export type MailboxPollJobData = {
  tenantId: string;
  mailboxAccountId: string;
};

/** A mailbox account polled in a batch — same shape as the job payload. */
export type MailboxPollTarget = MailboxPollJobData;

export type MailboxPollResult = {
  polled: MailboxPollTarget[];
};

const targetKey = ({ tenantId, mailboxAccountId }: MailboxPollTarget): string =>
  `${tenantId}:${mailboxAccountId}`;

/**
 * Example handler for the polling queue. It only reports which mailbox accounts
 * would be polled — the provider clients (Gmail API / Microsoft Graph) and the
 * triage pipeline land in later issues.
 *
 * A batch can contain the same mailbox account more than once (a poll job queued
 * while the previous one was still waiting), so targets are de-duplicated: polling
 * the same mailbox twice in one batch would only burn provider quota.
 */
export const handleMailboxPoll: WorkHandler<
  MailboxPollJobData,
  MailboxPollResult
> = async (jobs) => {
  const polled = new Map<string, MailboxPollTarget>();

  for (const { data } of jobs) {
    const target: MailboxPollTarget = {
      tenantId: data.tenantId,
      mailboxAccountId: data.mailboxAccountId,
    };
    polled.set(targetKey(target), target);
  }

  return { polled: [...polled.values()] };
};
