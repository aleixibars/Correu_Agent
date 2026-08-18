import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { encryptToken } from "@correu-agent/shared/token-encryption";
import type { Job } from "pg-boss";
import { describe, expect, it } from "vitest";
import {
  MAILBOX_POLL_QUEUE,
  createMailboxPollHandler,
  type MailboxPollJobData,
} from "./mailbox-poll";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT_ID = "44444444-4444-4444-4444-444444444444";
const MAILBOX_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_MAILBOX_ID = "33333333-3333-3333-3333-333333333333";
const ENCRYPTION_KEY = randomBytes(32);

const job = (data: MailboxPollJobData, id = "job-1"): Job<MailboxPollJobData> =>
  ({ id, name: MAILBOX_POLL_QUEUE, data }) as Job<MailboxPollJobData>;

/** In the column order `loadPollableMailboxAccount` selects. */
const accountRow = (
  id: string,
  tenantId: string,
  provider = "microsoft",
): unknown[] => [
  id,
  tenantId,
  provider,
  "bustia@example.com",
  encryptToken("stored-access-token", ENCRYPTION_KEY),
  encryptToken("stored-refresh-token", ENCRYPTION_KEY),
  "2030-01-01T00:00:00.000Z",
  `https://delta/${id}`,
  "2026-01-01T00:00:00.000Z",
];

const createDb = (rowsBySelect: unknown[][][]) => {
  let selects = 0;
  return drizzle(async (sql) => {
    if (!sql.startsWith("select")) return { rows: [] };
    return { rows: rowsBySelect[selects++] ?? [] };
  });
};

const graphPage = (messageId: string) => ({
  value: [
    {
      id: messageId,
      conversationId: `conversation-${messageId}`,
      internetMessageId: `<${messageId}@example.com>`,
      subject: "Pressupost",
      receivedDateTime: "2026-01-01T08:00:00Z",
      isDraft: false,
    },
  ],
  "@odata.deltaLink": "https://delta/next",
});

const stubFetch = (responseFor: (url: string) => unknown) => {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new Request(input as RequestInfo).url;
    urls.push(url);
    const body = responseFor(url);
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, urls };
};

const deps = (
  db: ReturnType<typeof createDb>,
  fetch: typeof globalThis.fetch,
) => ({
  db,
  microsoft: {
    clientId: "entra-client-id",
    clientSecret: "entra-client-secret",
    encryptionKey: ENCRYPTION_KEY,
    fetch,
  },
});

describe("mailbox poll queue", () => {
  it("is named after the mailbox polling job", () => {
    expect(MAILBOX_POLL_QUEUE).toBe("mailbox-poll");
  });
});

describe("createMailboxPollHandler", () => {
  it("returns the new mail of every mailbox in the batch, tagged with its mailbox", async () => {
    const db = createDb([
      [accountRow(MAILBOX_ID, TENANT_ID)],
      [accountRow(OTHER_MAILBOX_ID, OTHER_TENANT_ID)],
    ]);
    const { fetch } = stubFetch((url) =>
      graphPage(url.endsWith(MAILBOX_ID) ? "message-1" : "message-2"),
    );

    const result = await createMailboxPollHandler(deps(db, fetch))([
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }, "job-1"),
      job(
        { tenantId: OTHER_TENANT_ID, mailboxAccountId: OTHER_MAILBOX_ID },
        "job-2",
      ),
    ]);

    expect(result.polled).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(
      result.messages.map(({ mailboxAccountId, message }) => [
        mailboxAccountId,
        message.providerMessageId,
      ]),
    ).toEqual([
      [MAILBOX_ID, "message-1"],
      [OTHER_MAILBOX_ID, "message-2"],
    ]);
  });

  it("polls a mailbox once per batch even if queued more than once", async () => {
    const db = createDb([[accountRow(MAILBOX_ID, TENANT_ID)]]);
    const { fetch, urls } = stubFetch(() => graphPage("message-1"));

    const result = await createMailboxPollHandler(deps(db, fetch))([
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }, "job-1"),
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }, "job-2"),
    ]);

    // Polling the same mailbox twice in one batch only burns Graph quota.
    expect(urls).toHaveLength(1);
    expect(result.polled).toEqual([
      { tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID },
    ]);
  });

  it("skips a mailbox that was disconnected after the job was queued", async () => {
    const db = createDb([[]]);
    const { fetch, urls } = stubFetch(() => graphPage("message-1"));

    const result = await createMailboxPollHandler(deps(db, fetch))([
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }),
    ]);

    expect(urls).toEqual([]);
    expect(result).toEqual({ polled: [], messages: [], failed: [] });
  });

  it("keeps polling the rest of the batch when one mailbox fails", async () => {
    const db = createDb([
      [accountRow(MAILBOX_ID, TENANT_ID)],
      [accountRow(OTHER_MAILBOX_ID, OTHER_TENANT_ID)],
    ]);
    const { fetch } = stubFetch((url) =>
      url.endsWith(MAILBOX_ID)
        ? new Error("Graph is down")
        : graphPage("message-2"),
    );

    const result = await createMailboxPollHandler(deps(db, fetch))([
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }, "job-1"),
      job(
        { tenantId: OTHER_TENANT_ID, mailboxAccountId: OTHER_MAILBOX_ID },
        "job-2",
      ),
    ]);

    expect(result.failed).toEqual([
      {
        tenantId: TENANT_ID,
        mailboxAccountId: MAILBOX_ID,
        error: "Graph is down",
      },
    ]);
    expect(result.messages).toHaveLength(1);
  });

  it("fails the batch when no mailbox in it could be polled", async () => {
    const db = createDb([[accountRow(MAILBOX_ID, TENANT_ID)]]);
    const { fetch } = stubFetch(() => new Error("Graph is down"));

    // Reporting success here would mean the batch is never retried and the
    // mail is only seen 2 minutes later, if at all.
    await expect(
      createMailboxPollHandler(deps(db, fetch))([
        job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }),
      ]),
    ).rejects.toThrow(/Graph is down/);
  });

  it("reports a mailbox of a provider it cannot poll yet instead of dropping it", async () => {
    const db = createDb([[accountRow(MAILBOX_ID, TENANT_ID, "google")]]);
    const { fetch } = stubFetch(() => graphPage("message-1"));

    await expect(
      createMailboxPollHandler(deps(db, fetch))([
        job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }),
      ]),
    ).rejects.toThrow(/google/);
  });

  it("handles an empty batch", async () => {
    const db = createDb([]);
    const { fetch } = stubFetch(() => graphPage("message-1"));

    await expect(
      createMailboxPollHandler(deps(db, fetch))([]),
    ).resolves.toEqual({ polled: [], messages: [], failed: [] });
  });
});
