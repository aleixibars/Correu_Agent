import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { GmailPollTarget } from "../mailbox/gmail-poll";
import {
  MAILBOX_POLL_DISPATCH_QUEUE,
  createMailboxPollDispatchHandler,
} from "./mailbox-poll-dispatch";

const tick = (id = "tick-1"): Job<object> =>
  ({ id, name: MAILBOX_POLL_DISPATCH_QUEUE, data: {} }) as Job<object>;

const TARGETS: GmailPollTarget[] = [
  { tenantId: "tenant-1", mailboxAccountId: "mailbox-1" },
  { tenantId: "tenant-1", mailboxAccountId: "mailbox-2" },
];

describe("mailbox poll dispatch queue", () => {
  it("is named after the scheduled fan-out", () => {
    expect(MAILBOX_POLL_DISPATCH_QUEUE).toBe("mailbox-poll-dispatch");
  });
});

describe("createMailboxPollDispatchHandler", () => {
  it("queues one poll per connected mailbox", async () => {
    const queuePoll = vi.fn<(target: GmailPollTarget) => Promise<void>>(
      async () => {},
    );
    const handle = createMailboxPollDispatchHandler({
      listPollTargets: async () => TARGETS,
      queuePoll,
    });

    const result = await handle([tick()]);

    expect(result.queued).toEqual(TARGETS);
    expect(queuePoll.mock.calls.map(([target]) => target)).toEqual(TARGETS);
  });

  it("fans out once even when two scheduled ticks arrive together", async () => {
    const listPollTargets = vi.fn(async () => TARGETS);
    const handle = createMailboxPollDispatchHandler({
      listPollTargets,
      queuePoll: async () => {},
    });

    const result = await handle([tick("tick-1"), tick("tick-2")]);

    // A tick only means "poll everything now", so a second one in the same
    // batch would just queue the same mailboxes twice.
    expect(listPollTargets).toHaveBeenCalledTimes(1);
    expect(result.queued).toEqual(TARGETS);
  });

  it("does nothing when no mailbox is connected", async () => {
    const queuePoll = vi.fn<(target: GmailPollTarget) => Promise<void>>(
      async () => {},
    );
    const handle = createMailboxPollDispatchHandler({
      listPollTargets: async () => [],
      queuePoll,
    });

    await expect(handle([tick()])).resolves.toEqual({ queued: [] });
    expect(queuePoll).not.toHaveBeenCalled();
  });
});
