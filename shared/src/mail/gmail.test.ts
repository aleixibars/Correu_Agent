import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MESSAGES_PER_POLL,
  createGmailClient,
  createGmailSender,
} from "./gmail";

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

const outgoingReply = (overrides: Record<string, unknown> = {}) => ({
  fromAddress: "bustia@example.com",
  toAddresses: ["client@example.com"],
  ccAddresses: [] as string[],
  subject: "Re: Pressupost anual",
  bodyText: "Bon dia,\n\nUs enviem el pressupost.",
  providerThreadId: "thread-1",
  inReplyToProviderMessageId: "msg-1",
  inReplyTo: "<msg-1@example.com>",
  references: "<msg-0@example.com> <msg-1@example.com>",
  ...overrides,
});

const gmailAccepts = (body: unknown, status = 200) => {
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse(body, status);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const sentMime = (fetchMock: ReturnType<typeof gmailAccepts>) => {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const sent = JSON.parse(String(init.body)) as { raw: string; threadId: string };
  const mime = Buffer.from(sent.raw, "base64url").toString("utf8");
  const separator = mime.indexOf("\r\n\r\n");
  return {
    threadId: sent.threadId,
    headers: mime.slice(0, separator),
    body: Buffer.from(mime.slice(separator + 4), "base64").toString("utf8"),
  };
};

/** Undoes RFC 5322 folding, the way a receiving client does before reading a header. */
const unfold = (headers: string): string => headers.replace(/\r\n(?=[ \t])/g, "");

const decodeEncodedWords = (value: string): string =>
  value
    .split(/\s+/)
    .map((word) => {
      const match = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word);
      return match ? Buffer.from(match[1]!, "base64") : Buffer.from(word, "utf8");
    })
    .reduce((decoded, part) => Buffer.concat([decoded, part]), Buffer.alloc(0))
    .toString("utf8");

describe("createGmailSender", () => {
  it("sends the reply into the thread it answers", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1", threadId: "thread-1" });

    const result = await createGmailSender(ACCESS_TOKEN).sendReply(outgoingReply());

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/messages/send");
    const { threadId, headers, body } = sentMime(fetchMock);
    // Gmail threads by `threadId`; every other client threads by the headers.
    expect(threadId).toBe("thread-1");
    expect(headers).toContain("From: bustia@example.com");
    expect(headers).toContain("To: client@example.com");
    expect(headers).toContain("In-Reply-To: <msg-1@example.com>");
    expect(headers).toContain(
      "References: <msg-0@example.com> <msg-1@example.com>",
    );
    // RFC 2045 §6.8: the canonical form of a text body ends its lines with CRLF.
    expect(body).toBe("Bon dia,\r\n\r\nUs enviem el pressupost.");
    expect(result).toEqual({ providerMessageId: "sent-1", messageIdHeader: null });
  });

  it("encodes a subject a header cannot carry as it stands", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({ subject: "Re: Pressupost de l\u2019any" }),
    );

    // RFC 2047, or the accent would not survive a US-ASCII header.
    expect(sentMime(fetchMock).headers).toContain("Subject: =?UTF-8?B?");
  });

  it("sends a subject-less reply without a header that ends in whitespace", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    // Mail that arrived untitled is answered untitled (`replySubject`), so the
    // header carries no value at all.
    await createGmailSender(ACCESS_TOKEN).sendReply(outgoingReply({ subject: "" }));

    expect(sentMime(fetchMock).headers.split("\r\n")).toContain("Subject:");
  });

  it("does not let a line break in a subject open a header of its own", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({ subject: "Pressupost\r\nBcc: tercer@example.com" }),
    );

    const lines = sentMime(fetchMock).headers.split("\r\n");
    expect(lines.some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(lines).toContain("Subject: Pressupost Bcc: tercer@example.com");
  });

  it("leaves the threading headers out when the mail answered had no Message-ID", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({ inReplyTo: null, references: null }),
    );

    const { headers } = sentMime(fetchMock);
    expect(headers).not.toContain("In-Reply-To:");
    expect(headers).not.toContain("References:");
  });

  it("folds a References chain too long to be one line", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });
    // A thread grows its chain by one id per mail, so a long conversation runs
    // past the line limit on its own.
    const chain = Array.from(
      { length: 30 },
      (_, index) => `<msg-${index}@mail.example.com>`,
    ).join(" ");

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({ references: chain }),
    );

    const { headers } = sentMime(fetchMock);
    const lines = headers.split("\r\n");
    expect(lines.filter((line) => line.startsWith(" <msg-")).length).toBeGreaterThan(0);
    expect(lines.every((line) => line.length <= 78)).toBe(true);
    // Folding is whitespace only: unfolding gives the chain back untouched.
    expect(unfold(headers)).toContain(`References: ${chain}`);
  });

  it("splits a long accented subject into encoded words a decoder can rejoin", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });
    const subject = `Re: ${"Pressupost de l\u2019any per a la reuni\u00f3 ".repeat(4)}`.trim();

    await createGmailSender(ACCESS_TOKEN).sendReply(outgoingReply({ subject }));

    const { headers } = sentMime(fetchMock);
    const encoded = unfold(headers)
      .split("\r\n")
      .find((line) => line.startsWith("Subject: "))!
      .slice("Subject: ".length);
    // RFC 2047 §2 caps an encoded word at 75 characters, wrapping included.
    for (const word of encoded.split(" ")) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeEncodedWords(encoded)).toBe(subject);
  });

  it("fails loudly when Gmail refuses the send", async () => {
    gmailAccepts({ error: { message: "Insufficient Permission" } }, 403);

    await expect(
      createGmailSender(ACCESS_TOKEN).sendReply(outgoingReply()),
    ).rejects.toThrow(/Insufficient Permission/);
  });
});
