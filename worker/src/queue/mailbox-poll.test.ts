import type { Job } from "pg-boss";
import { describe, expect, it } from "vitest";
import {
  MAILBOX_POLL_QUEUE,
  handleMailboxPoll,
  type MailboxPollJobData,
} from "./mailbox-poll";

const job = (data: MailboxPollJobData, id = "job-1"): Job<MailboxPollJobData> =>
  ({ id, name: MAILBOX_POLL_QUEUE, data }) as Job<MailboxPollJobData>;

describe("mailbox poll queue", () => {
  it("is named after the mailbox polling job", () => {
    expect(MAILBOX_POLL_QUEUE).toBe("mailbox-poll");
  });
});

describe("handleMailboxPoll", () => {
  it("reports every mailbox account in the batch", async () => {
    const result = await handleMailboxPoll([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-1"),
      job({ tenantId: "tenant-2", mailboxAccountId: "mailbox-2" }, "job-2"),
    ]);

    expect(result.polled).toEqual([
      { tenantId: "tenant-1", mailboxAccountId: "mailbox-1" },
      { tenantId: "tenant-2", mailboxAccountId: "mailbox-2" },
    ]);
  });

  it("polls a mailbox account once per batch even if queued more than once", async () => {
    const result = await handleMailboxPoll([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-1"),
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-2"),
    ]);

    expect(result.polled).toEqual([
      { tenantId: "tenant-1", mailboxAccountId: "mailbox-1" },
    ]);
  });

  it("keeps the same mailbox account id of two different tenants apart", async () => {
    const result = await handleMailboxPoll([
      job({ tenantId: "tenant-1", mailboxAccountId: "mailbox-1" }, "job-1"),
      job({ tenantId: "tenant-2", mailboxAccountId: "mailbox-1" }, "job-2"),
    ]);

    expect(result.polled).toHaveLength(2);
  });

  it("handles an empty batch", async () => {
    await expect(handleMailboxPoll([])).resolves.toEqual({ polled: [] });
  });
});
