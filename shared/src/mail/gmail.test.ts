import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGES_PER_POLL, createGmailClient } from "./gmail";

const ACCESS_TOKEN = "access-1";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const base64url = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

const gmailMessage = ({
  id = "msg-1",
  threadId = "thread-1",
  labelIds = ["INBOX", "UNREAD"],
  headers = [
    { name: "From", value: "Client <client@example.com>" },
    { name: "To", value: "Bustia <bustia@example.com>, altre@example.com" },
    { name: "Cc", value: "copia@example.com" },
    { name: "Subject", value: "Pressupost" },
    { name: "Message-ID", value: "<msg-1@example.com>" },
    { name: "In-Reply-To", value: "<msg-0@example.com>" },
    { name: "References", value: "<msg-0@example.com>" },
  ],
} = {}) => ({
  id,
  threadId,
  labelIds,
  snippet: "Bon dia,",
  internalDate: "1700000000000",
  payload: {
    mimeType: "multipart/alternative",
    headers,
    parts: [
      {
        mimeType: "text/plain",
        body: { data: base64url("Bon dia, voldria un pressupost.") },
      },
      {
        mimeType: "text/html",
        body: { data: base64url("<p>Bon dia, voldria un pressupost.</p>") },
      },
    ],
  },
});

/** Answers each Gmail endpoint by URL, so the order of calls is not baked into the test. */
const gmailResponds = (
  routes: { history?: unknown[]; messages?: Record<string, unknown>; profile?: unknown },
) => {
  const history = [...(routes.history ?? [])];
  const requested: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    void init;
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);

    if (url.pathname.endsWith("/history")) {
      const page = history.shift();
      return jsonResponse(page ?? { historyId: "1000" });
    }
    if (url.pathname.endsWith("/profile")) {
      return jsonResponse(routes.profile ?? { emailAddress: "bustia@example.com", historyId: "9000" });
    }
    const id = url.pathname.split("/").pop()!;
    const message = routes.messages?.[id];
    return message ? jsonResponse(message) : jsonResponse({ error: { message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requested };
};

const added = (id: string, extra: Record<string, unknown> = {}) => ({
  message: { id, threadId: "thread-1", labelIds: ["INBOX"], ...extra },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGmailClient", () => {
  it("returns the messages added since the stored cursor", async () => {
    const { requested } = gmailResponds({
      history: [{ history: [{ id: "1001", messagesAdded: [added("msg-1")] }], historyId: "1100" }],
      messages: { "msg-1": gmailMessage() },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.cursor).toBe("1100");
    expect(result.cursorReset).toBe(false);
    expect(result.messages).toEqual([
      {
        providerMessageId: "msg-1",
        providerThreadId: "thread-1",
        direction: "inbound",
        messageIdHeader: "<msg-1@example.com>",
        inReplyTo: "<msg-0@example.com>",
        references: "<msg-0@example.com>",
        fromAddress: "client@example.com",
        toAddresses: ["bustia@example.com", "altre@example.com"],
        ccAddresses: ["copia@example.com"],
        subject: "Pressupost",
        snippet: "Bon dia,",
        bodyText: "Bon dia, voldria un pressupost.",
        bodyHtml: "<p>Bon dia, voldria un pressupost.</p>",
        sentAt: new Date(1700000000000),
      },
    ]);
    // Only new mail is polled (context.md §4): history is asked for from the cursor.
    expect(requested[0]).toContain("startHistoryId=1000");
  });

  it("follows history pages and keeps the last cursor", async () => {
    gmailResponds({
      history: [
        {
          history: [{ id: "1001", messagesAdded: [added("msg-1")] }],
          nextPageToken: "page-2",
          historyId: "1100",
        },
        { history: [{ id: "1002", messagesAdded: [added("msg-2")] }], historyId: "1200" },
      ],
      messages: {
        "msg-1": gmailMessage(),
        "msg-2": gmailMessage({ id: "msg-2", threadId: "thread-2" }),
      },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages.map((message) => message.providerMessageId)).toEqual([
      "msg-1",
      "msg-2",
    ]);
    expect(result.cursor).toBe("1200");
  });

  it("fetches a message once even if history reports it twice", async () => {
    const { fetchMock } = gmailResponds({
      history: [
        {
          history: [
            { id: "1001", messagesAdded: [added("msg-1")] },
            { id: "1002", messagesAdded: [added("msg-1")] },
          ],
          historyId: "1100",
        },
      ],
      messages: { "msg-1": gmailMessage() },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages).toHaveLength(1);
    const gets = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/messages/msg-1"),
    );
    expect(gets).toHaveLength(1);
  });

  it("marks mail the mailbox itself sent as outbound", async () => {
    gmailResponds({
      history: [{ history: [{ id: "1001", messagesAdded: [added("msg-1")] }], historyId: "1100" }],
      messages: { "msg-1": gmailMessage({ labelIds: ["SENT"] }) },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages[0]!.direction).toBe("outbound");
  });

  it("ignores drafts, which are not mail that arrived", async () => {
    gmailResponds({
      history: [
        {
          history: [{ id: "1001", messagesAdded: [added("msg-1", { labelIds: ["DRAFT"] })] }],
          historyId: "1100",
        },
      ],
      messages: { "msg-1": gmailMessage({ labelIds: ["DRAFT"] }) },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages).toEqual([]);
    expect(result.cursor).toBe("1100");
  });

  it("ignores mail already in the bin, which nobody is waiting on", async () => {
    gmailResponds({
      history: [{ history: [{ id: "1001", messagesAdded: [added("msg-1")] }], historyId: "1100" }],
      messages: { "msg-1": gmailMessage({ labelIds: ["TRASH"] }) },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages).toEqual([]);
    expect(result.cursor).toBe("1100");
  });

  it("skips a message deleted between the history page and the fetch", async () => {
    gmailResponds({
      history: [
        {
          history: [
            { id: "1001", messagesAdded: [added("msg-gone"), added("msg-1")] },
          ],
          historyId: "1100",
        },
      ],
      messages: { "msg-1": gmailMessage() },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages.map((message) => message.providerMessageId)).toEqual([
      "msg-1",
    ]);
  });

  it("returns nothing when the mailbox saw no change", async () => {
    gmailResponds({ history: [{ historyId: "1100" }] });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result).toEqual({ messages: [], cursor: "1100", cursorReset: false });
  });

  it("resets the cursor to now when Gmail has expired the stored history", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/history")) {
        return jsonResponse({ error: { message: "Requested entity was not found." } }, 404);
      }
      return jsonResponse({ emailAddress: "bustia@example.com", historyId: "9000" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1");

    // The backlog is deliberately not imported (context.md §4): polling just
    // restarts from now rather than replaying whatever Gmail still remembers.
    expect(result).toEqual({ messages: [], cursor: "9000", cursorReset: true });
  });

  it("starts a mailbox without a cursor from now, processing nothing", async () => {
    const { requested } = gmailResponds({});

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages(null);

    expect(result).toEqual({ messages: [], cursor: "9000", cursorReset: true });
    expect(requested.every((path) => !path.includes("/history"))).toBe(true);
  });

  it("stops at the message cap and resumes from the last history record taken", async () => {
    const ids = Array.from({ length: MAX_MESSAGES_PER_POLL + 5 }, (_, i) => `msg-${i}`);
    const { fetchMock } = gmailResponds({
      history: [
        {
          // One record per message, so the cap lands mid-page and the resume
          // point is a record id rather than the page's `historyId`.
          history: ids.map((id, index) => ({
            id: String(2000 + index),
            messagesAdded: [added(id)],
          })),
          nextPageToken: "page-2",
          historyId: "9999",
        },
      ],
      messages: Object.fromEntries(
        ids.map((id) => [id, gmailMessage({ id })]),
      ),
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages).toHaveLength(MAX_MESSAGES_PER_POLL);
    // Not "9999": that is where the mailbox is now, and taking it would skip
    // the messages this poll deliberately left for the next tick.
    expect(result.cursor).toBe(String(2000 + MAX_MESSAGES_PER_POLL - 1));
    expect(result.cursorReset).toBe(false);
    // The truncated poll also stops asking for further pages.
    const historyCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/history"),
    );
    expect(historyCalls).toHaveLength(1);
  });

  it("takes a single oversized history record whole, so the cursor always moves", async () => {
    const ids = Array.from({ length: MAX_MESSAGES_PER_POLL + 5 }, (_, i) => `msg-${i}`);
    gmailResponds({
      history: [
        {
          history: [{ id: "2001", messagesAdded: ids.map((id) => added(id)) }],
          nextPageToken: "page-2",
          historyId: "9999",
        },
      ],
      messages: Object.fromEntries(ids.map((id) => [id, gmailMessage({ id })])),
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages).toHaveLength(ids.length);
    expect(result.cursor).toBe("2001");
  });

  it("keeps the mail of the pages it read when a later history page is gone", async () => {
    let historyCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/history")) {
          historyCalls += 1;
          // The stored cursor was good a moment ago, so the second page going
          // missing is not an expired history window.
          return historyCalls === 1
            ? jsonResponse({
                history: [{ id: "1001", messagesAdded: [added("msg-1")] }],
                nextPageToken: "page-2",
                historyId: "9999",
              })
            : jsonResponse({ error: { message: "Not Found" } }, 404);
        }
        if (url.pathname.endsWith("/profile")) {
          return jsonResponse({ historyId: "9000" });
        }
        return jsonResponse(gmailMessage());
      }),
    );

    const result = await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    expect(result.messages.map((message) => message.providerMessageId)).toEqual([
      "msg-1",
    ]);
    // Neither "9999" nor a restart from now: both would skip the history this
    // poll never reached.
    expect(result.cursor).toBe("1001");
    expect(result.cursorReset).toBe(false);
  });

  it("sends the mailbox access token on every request", async () => {
    const { fetchMock } = gmailResponds({
      history: [{ history: [{ id: "1001", messagesAdded: [added("msg-1")] }], historyId: "1100" }],
      messages: { "msg-1": gmailMessage() },
    });

    await createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000");

    for (const [, init] of fetchMock.mock.calls) {
      expect(init!.headers).toMatchObject({
        authorization: `Bearer ${ACCESS_TOKEN}`,
      });
    }
  });

  it("reports a Gmail failure that is not an expired cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Rate Limit Exceeded" } }, 429)),
    );

    await expect(
      createGmailClient(ACCESS_TOKEN).fetchNewMessages("1000"),
    ).rejects.toThrow(/Rate Limit Exceeded/);
  });
});
