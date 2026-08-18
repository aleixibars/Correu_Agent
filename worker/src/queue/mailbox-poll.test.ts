import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { encryptToken } from "@correu-agent/shared/token-encryption";
import type { Job } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAILBOX_POLL_QUEUE,
  createMailboxPollHandler,
  type MailboxPollJobData,
} from "./mailbox-poll";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "55555555-5555-5555-5555-555555555555";
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
  // Graph delta link / Gmail historyId — whatever this provider resumes from.
  provider === "google" ? "1000" : `https://delta/${id}`,
  "2026-01-01T00:00:00.000Z",
];

/** In the column order the thread upsert returns: id, category, triagedAt, created. */
const threadRow = (triagedAt: string | null = null) => [
  THREAD_ID,
  triagedAt ? "comercial" : null,
  triagedAt,
  triagedAt === null,
];

const createDb = (
  rowsBySelect: unknown[][][],
  thread: unknown[] = threadRow(),
) => {
  let selects = 0;
  return drizzle(async (sql) => {
    if (sql.startsWith("select")) return { rows: rowsBySelect[selects++] ?? [] };
    // The poll persists what it found (`persistPolledMessages`); the thread
    // upsert and the message insert both report back what they wrote.
    if (sql.includes('insert into "threads"')) return { rows: [thread] };
    if (sql.includes('insert into "messages"')) return { rows: [["message-1"]] };
    return { rows: [] };
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
  // The Gmail client reads the global fetch, so it is stubbed per test instead.
  google: {
    credentials: { clientId: "google-client-id", clientSecret: "google-client-secret" },
    encryptionKey: ENCRYPTION_KEY,
  },
  microsoft: {
    clientId: "entra-client-id",
    clientSecret: "entra-client-secret",
    encryptionKey: ENCRYPTION_KEY,
    fetch,
  },
});

/** Gmail with one new message waiting since the mailbox's stored historyId. */
const gmailResponds = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const body = url.pathname.endsWith("/history")
        ? {
            history: [
              {
                id: "1001",
                messagesAdded: [
                  {
                    message: {
                      id: "gmail-1",
                      threadId: "thread-1",
                      labelIds: ["INBOX"],
                    },
                  },
                ],
              },
            ],
            historyId: "1100",
          }
        : {
            id: "gmail-1",
            threadId: "thread-1",
            labelIds: ["INBOX"],
            internalDate: "1700000000000",
            payload: { mimeType: "text/plain", headers: [] },
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
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
      result.threads.map(({ mailboxAccountId, providerThreadId }) => [
        mailboxAccountId,
        providerThreadId,
      ]),
    ).toEqual([
      [MAILBOX_ID, "conversation-message-1"],
      [OTHER_MAILBOX_ID, "conversation-message-2"],
    ]);
  });

  it("stores the mail it found and hands the thread on for triage", async () => {
    const statements: string[] = [];
    const db = drizzle(async (sql) => {
      statements.push(sql);
      if (sql.startsWith("select")) return { rows: [accountRow(MAILBOX_ID, TENANT_ID)] };
      if (sql.includes('insert into "threads"')) return { rows: [threadRow()] };
      if (sql.includes('insert into "messages"')) return { rows: [["message-1"]] };
      return { rows: [] };
    });
    const { fetch } = stubFetch(() => graphPage("message-1"));

    const result = await createMailboxPollHandler(deps(db, fetch))([
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }),
    ]);

    expect(statements.some((sql) => sql.includes('insert into "threads"'))).toBe(true);
    expect(statements.some((sql) => sql.includes('insert into "messages"'))).toBe(true);
    expect(result.threads).toEqual([
      {
        tenantId: TENANT_ID,
        mailboxAccountId: MAILBOX_ID,
        threadId: THREAD_ID,
        providerThreadId: "conversation-message-1",
        needsTriage: true,
        newMessages: 1,
      },
    ]);
  });

  it("does not send a thread that was already triaged back through triage", async () => {
    const db = createDb(
      [[accountRow(MAILBOX_ID, TENANT_ID)]],
      threadRow("2026-01-01T08:00:00.000Z"),
    );
    const { fetch } = stubFetch(() => graphPage("message-1"));

    const result = await createMailboxPollHandler(deps(db, fetch))([
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }),
    ]);

    // A reply inside a triaged thread is stored, but the thread keeps the
    // category it already has (context.md §4).
    expect(result.threads[0]).toMatchObject({
      threadId: THREAD_ID,
      needsTriage: false,
      newMessages: 1,
    });
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
    expect(result).toEqual({ polled: [], threads: [], failed: [] });
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

    const error = vi.spyOn(console, "error").mockImplementation(() => {});

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
    expect(result.threads).toHaveLength(1);
    // A permanently broken mailbox has to be visible in the log too: the job
    // result of a batch that otherwise succeeded is nobody's alarm.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(MAILBOX_ID),
      expect.anything(),
    );
    error.mockRestore();
  });

  it("fails the batch when no mailbox in it could be polled", async () => {
    const db = createDb([[accountRow(MAILBOX_ID, TENANT_ID)]]);
    const { fetch } = stubFetch(() => new Error("Graph is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // Reporting success here would mean the batch is never retried and the
    // mail is only seen 2 minutes later, if at all.
    await expect(
      createMailboxPollHandler(deps(db, fetch))([
        job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }),
      ]),
    ).rejects.toThrow(/Graph is down/);

    error.mockRestore();
  });

  it("polls a Gmail mailbox with the Gmail poller", async () => {
    const db = createDb([[accountRow(MAILBOX_ID, TENANT_ID, "google")]]);
    const { fetch } = stubFetch(() => graphPage("message-1"));
    gmailResponds();

    const result = await createMailboxPollHandler(deps(db, fetch))([
      job({ tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID }),
    ]);

    // Which provider a mailbox belongs to is read from its row, not from the
    // job payload: the queue carries one kind of poll job for both providers.
    expect(result.threads.map(({ providerThreadId }) => providerThreadId)).toEqual([
      "thread-1",
    ]);
    expect(result.failed).toEqual([]);
  });

  it("handles an empty batch", async () => {
    const db = createDb([]);
    const { fetch } = stubFetch(() => graphPage("message-1"));

    await expect(
      createMailboxPollHandler(deps(db, fetch))([]),
    ).resolves.toEqual({ polled: [], threads: [], failed: [] });
  });
});
