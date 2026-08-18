import type { Job } from "pg-boss";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { GmailPollOutcome, GmailPollTarget } from "../mailbox/gmail-poll";
import {
  MAILBOX_POLL_QUEUE,
  createMailboxPollHandler,
  type MailboxPollJobData,
} from "./mailbox-poll";

const job = (data: MailboxPollJobData, id = "job-1"): Job<MailboxPollJobData> =>
  ({ id, name: MAILBOX_POLL_QUEUE, data }) as Job<MailboxPollJobData>;

const outcome = (
  target: GmailPollTarget,
  messages = 0,
): GmailPollOutcome => ({
  ...target,
  messages: Array.from({ length: messages }, (_, index) => ({
    providerMessageId: `msg-${index}`,
    providerThreadId: "thread-1",
    direction: "inbound",
    messageIdHeader: null,
    inReplyTo: null,
    references: null,
    fromAddress: "client@example.com",
    toAddresses: ["bustia@example.com"],
    ccAddresses: [],
    subject: null,
    snippet: null,
    bodyText: null,
    bodyHtml: null,
    sentAt: null,
  })),
  cursor: "1100",
  cursorReset: false,
});

type PollMock = Mock<(target: GmailPollTarget) => Promise<GmailPollOutcome | null>>;

const handlerPolling = (
  pollGmailMailbox: PollMock = vi.fn(async (target: GmailPollTarget) =>
    outcome(target),
  ),
) => ({
  handle: createMailboxPollHandler({ pollGmailMailbox }),
  pollGmailMailbox,
});

describe("mailbox poll queue", () => {
  it("is named after the mailbox polling job", () => {
    expect(MAILBOX_POLL_QUEUE).toBe("mailbox-poll");
  });
});

describe("createMailboxPollHandler", () => {
  it("polls every mailbox account in the batch", async () => {
    const { handle, pollGmailMailbox } = handlerPolling();

    const result = await handle([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-1"),
      job({ tenantId: "tenant-2", mailboxAccountId: "mailbox-2" }, "job-2"),
    ]);

    expect(pollGmailMailbox).toHaveBeenCalledTimes(2);
    expect(result.polled).toEqual([
      { tenantId: "tenant-1", mailboxAccountId: "mailbox-1", newMessages: 0, cursor: "1100" },
      { tenantId: "tenant-2", mailboxAccountId: "mailbox-2", newMessages: 0, cursor: "1100" },
    ]);
  });

  it("reports how much new mail a poll found", async () => {
    const { handle } = handlerPolling(
      vi.fn(async (target: GmailPollTarget) => outcome(target, 3)),
    );

    const result = await handle([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }),
    ]);

    // The messages themselves are deliberately not part of the job result:
    // pg-boss would store the mail bodies alongside the job (context.md §7).
    expect(result.polled[0]).toEqual({
      tenantId: "tenant-1",
      mailboxAccountId: "mailbox-1",
      newMessages: 3,
      cursor: "1100",
    });
  });

  it("polls a mailbox account once per batch even if queued more than once", async () => {
    const { handle, pollGmailMailbox } = handlerPolling();

    const result = await handle([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-1"),
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-2"),
    ]);

    expect(pollGmailMailbox).toHaveBeenCalledTimes(1);
    expect(result.polled).toHaveLength(1);
  });

  it("keeps the same mailbox account id of two different tenants apart", async () => {
    const { handle } = handlerPolling();

    const result = await handle([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-1"),
      job({ tenantId: "tenant-2", mailboxAccountId: "mailbox-1" }, "job-2"),
    ]);

    expect(result.polled).toHaveLength(2);
  });

  it("leaves a disconnected mailbox out of the result", async () => {
    const { handle } = handlerPolling(vi.fn(async () => null));

    const result = await handle([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }),
    ]);

    expect(result.polled).toEqual([]);
  });

  it("handles an empty batch", async () => {
    const { handle } = handlerPolling();

    await expect(handle([])).resolves.toEqual({ polled: [] });
  });
});
