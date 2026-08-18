import type { WorkHandler } from "pg-boss";
import type { MailboxPollTarget } from "./mailbox-poll";

/**
 * The queue pg-boss runs on a cron schedule (context.md §8). It holds no
 * payload: one tick means "poll every connected mailbox now", and the fan-out
 * into one `mailbox-poll` job per mailbox happens here, so a mailbox connected
 * a minute ago is picked up on the next tick without rescheduling anything.
 */
export const MAILBOX_POLL_DISPATCH_QUEUE = "mailbox-poll-dispatch";

export type MailboxPollDispatchResult = {
  queued: MailboxPollTarget[];
};

export type MailboxPollDispatchDependencies = {
  listPollTargets: () => Promise<MailboxPollTarget[]>;
  queuePoll: (target: MailboxPollTarget) => Promise<void>;
};

export const createMailboxPollDispatchHandler = ({
  listPollTargets,
  queuePoll,
}: MailboxPollDispatchDependencies): WorkHandler<
  object,
  MailboxPollDispatchResult
> => async () => {
  // The batch is ignored on purpose: every tick asks for the same thing, so two
  // of them arriving together still mean one round of polling.
  const targets = await listPollTargets();

  for (const target of targets) {
    await queuePoll(target);
  }

  return { queued: targets };
};
