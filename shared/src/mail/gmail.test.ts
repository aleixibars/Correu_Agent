import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MESSAGES_PER_POLL,
  createGmailClient,
  createGmailSender,
} from "./gmail";
import type { ReplyAttachment } from "./types";

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
  routes: {
    history?: unknown[];
    messages?: Record<string, unknown>;
    profile?: unknown;
    /** Pages for `GET /messages?q=...`, the search `fetchMessagesSince` lists ids from. */
    search?: unknown[];
  },
) => {
  const history = [...(routes.history ?? [])];
  const search = [...(routes.search ?? [])];
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
    // The bare list endpoint, as opposed to `/messages/{id}` below.
    if (url.pathname.endsWith("/messages") && url.searchParams.has("q")) {
      const page = search.shift();
      return jsonResponse(page ?? { messages: [] });
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

describe("createGmailClient().fetchMessagesSince", () => {
  it("fetches the mail Gmail's search finds after the given instant", async () => {
    const { requested } = gmailResponds({
      search: [{ messages: [{ id: "msg-1", threadId: "thread-1" }] }],
      messages: { "msg-1": gmailMessage() },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchMessagesSince(1_700_000_000);

    expect(result.messages.map((message) => message.providerMessageId)).toEqual([
      "msg-1",
    ]);
    // `after:` is a Gmail search operator, not a history cursor (context.md
    // §4) — this is a one-time catch-up, never the 2-minute poll.
    expect(requested[0]).toContain("q=after%3A1700000000");
  });

  it("follows search pages, de-duplicated the same way history is", async () => {
    gmailResponds({
      search: [
        { messages: [{ id: "msg-1" }], nextPageToken: "page-2" },
        { messages: [{ id: "msg-2" }] },
      ],
      messages: {
        "msg-1": gmailMessage(),
        "msg-2": gmailMessage({ id: "msg-2", threadId: "thread-2" }),
      },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchMessagesSince(0);

    expect(result.messages.map((message) => message.providerMessageId)).toEqual([
      "msg-1",
      "msg-2",
    ]);
  });

  it("returns nothing when the search finds no mail", async () => {
    gmailResponds({ search: [{}] });

    const result = await createGmailClient(ACCESS_TOKEN).fetchMessagesSince(0);

    expect(result.messages).toEqual([]);
  });

  it("excludes drafts and trashed mail, same as the incremental poll", async () => {
    gmailResponds({
      search: [{ messages: [{ id: "msg-1" }, { id: "msg-2" }] }],
      messages: {
        "msg-1": gmailMessage({ labelIds: ["DRAFT"] }),
        "msg-2": gmailMessage({ id: "msg-2", labelIds: ["TRASH"] }),
      },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchMessagesSince(0);

    expect(result.messages).toEqual([]);
  });

  it("skips a message deleted between the search and the fetch", async () => {
    gmailResponds({
      search: [{ messages: [{ id: "msg-gone" }, { id: "msg-1" }] }],
      messages: { "msg-1": gmailMessage() },
    });

    const result = await createGmailClient(ACCESS_TOKEN).fetchMessagesSince(0);

    expect(result.messages.map((message) => message.providerMessageId)).toEqual([
      "msg-1",
    ]);
  });
});

const outgoingReply = (overrides: Record<string, unknown> = {}) => ({
  attachments: [] as ReplyAttachment[],
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

/** The RFC 5322 message Gmail was handed, as it went out. */
const sentRawMime = (fetchMock: ReturnType<typeof gmailAccepts>): string => {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const sent = JSON.parse(String(init.body)) as { raw: string };
  return Buffer.from(sent.raw, "base64url").toString("utf8");
};

const sentMime = (fetchMock: ReturnType<typeof gmailAccepts>) => {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const sent = JSON.parse(String(init.body)) as { raw: string; threadId: string };
  const mime = sentRawMime(fetchMock);
  const separator = mime.indexOf("\r\n\r\n");
  return {
    threadId: sent.threadId,
    headers: mime.slice(0, separator),
    body: Buffer.from(mime.slice(separator + 4), "base64").toString("utf8"),
  };
};

/** One part of a multipart message, split into its headers and decoded content. */
const part = (raw: string): { headers: string; content: Buffer } => {
  const separator = raw.indexOf("\r\n\r\n");
  return {
    headers: raw.slice(0, separator),
    content: Buffer.from(raw.slice(separator + 4), "base64"),
  };
};

/** Splits a multipart body on the boundary its headers declare. */
const multipart = (mime: string): { boundary: string; parts: string[] } => {
  const boundary = /boundary="([^"]+)"/.exec(unfold(mime))?.[1] ?? "";
  return { boundary, parts: mime.split(`--${boundary}`) };
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

  it("sends a reply carrying files as a multipart message", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "pressupost.pdf",
            mimeType: "application/pdf",
            content: Buffer.from("%PDF-1.4 pressupost"),
          },
        ],
      }),
    );

    const mime = sentRawMime(fetchMock);
    const { boundary, parts } = multipart(mime);
    // The declaration is longer than a line, so it travels folded (RFC 5322
    // §2.2.3) exactly as a long `References` chain does.
    expect(unfold(mime)).toContain(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
    );
    // Preamble, the text of the reply, the file, and the closing delimiter.
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe("--\r\n");

    const body = part(parts[1]!.slice(2));
    expect(body.headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(body.headers).toContain("Content-Transfer-Encoding: base64");
    expect(body.content.toString("utf8")).toBe(
      "Bon dia,\r\n\r\nUs enviem el pressupost.",
    );

    const attachment = part(parts[2]!.slice(2));
    expect(attachment.headers).toContain("Content-Type: application/pdf");
    expect(attachment.headers).toContain(
      'Content-Disposition: attachment; filename="pressupost.pdf"',
    );
    expect(attachment.headers).toContain("Content-Transfer-Encoding: base64");
    expect(attachment.content.toString("utf8")).toBe("%PDF-1.4 pressupost");
  });

  it("sends every file the reply carries as a part of its own", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "primer.txt",
            mimeType: "text/plain",
            content: Buffer.from("primer"),
          },
          {
            filename: "segon.txt",
            mimeType: "text/plain",
            content: Buffer.from("segon"),
          },
        ],
      }),
    );

    const { parts } = multipart(sentRawMime(fetchMock));
    // Preamble, the text, the two files, and the closing delimiter.
    expect(parts).toHaveLength(5);
    expect(part(parts[2]!.slice(2)).content.toString("utf8")).toBe("primer");
    expect(part(parts[3]!.slice(2)).content.toString("utf8")).toBe("segon");
  });

  // Binary content is what an attachment usually is: a PDF or an image survives
  // only if the part is base64 of the bytes, not of some decoding of them.
  it("keeps the bytes of a binary file exactly as they came in", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });
    const content = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0a, 0x0d, 0xc3]);

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          { filename: "logo.png", mimeType: "image/png", content },
        ],
      }),
    );

    const { parts } = multipart(sentRawMime(fetchMock));
    expect(part(parts[2]!.slice(2)).content.equals(content)).toBe(true);
  });

  // RFC 2045 §6.8: no line of a base64 body may run past 76 characters.
  it("folds the base64 of a file into lines a receiving MTA accepts", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "llarg.txt",
            mimeType: "text/plain",
            content: Buffer.alloc(5000, "a"),
          },
        ],
      }),
    );

    const { parts } = multipart(sentRawMime(fetchMock));
    const lines = parts[2]!.split("\r\n");
    expect(lines.every((line) => line.length <= 76)).toBe(true);
  });

  // A filename is browser-supplied text: a line break in it would end the part
  // headers and let the rest be read as headers, or as a part, of its own.
  it("does not let a filename open a header of its own", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: 'factura\r\nBcc: tercer@example.com\r\n\r\n"x".pdf',
            mimeType: "application/pdf",
            content: Buffer.from("dades"),
          },
        ],
      }),
    );

    const mime = sentRawMime(fetchMock);
    expect(mime.split("\r\n").some((line) => line.startsWith("Bcc:"))).toBe(false);
    const attachment = part(multipart(mime).parts[2]!.slice(2));
    expect(attachment.content.toString("utf8")).toBe("dades");
    expect(attachment.headers).toContain(
      'filename="factura Bcc: tercer@example.com \\"x\\".pdf"',
    );
  });

  // An accented filename cannot travel as it stands in a US-ASCII header.
  it("encodes an accented filename as an RFC 2047 word", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "informaci\u00f3.pdf",
            mimeType: "application/pdf",
            content: Buffer.from("dades"),
          },
        ],
      }),
    );

    const attachment = part(multipart(sentRawMime(fetchMock)).parts[2]!.slice(2));
    expect(attachment.headers).toContain('filename="=?UTF-8?B?');
    expect(attachment.headers).not.toContain("informaci\u00f3");
    // RFC 2047 §5 forbids an encoded word inside a quoted string, so the name a
    // client is meant to read is the RFC 2231 one; the quoted word above is the
    // fallback for a client that knows only `filename`.
    expect(attachment.headers).toContain(
      "filename*=UTF-8''informaci%C3%B3.pdf",
    );
  });

  // A parameter carries the name percent-encoded, so what a filename holds
  // cannot end the parameter or open one of its own.
  it("percent-encodes what a filename may not carry bare in a parameter", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "n\u00f2mines (2026); x'y*z.pdf",
            mimeType: "application/pdf",
            content: Buffer.from("dades"),
          },
        ],
      }),
    );

    const attachment = part(multipart(sentRawMime(fetchMock)).parts[2]!.slice(2));
    expect(attachment.headers).toContain(
      "filename*=UTF-8''n%C3%B2mines%20%282026%29%3B%20x%27y%2Az.pdf",
    );
  });

  // Only a name that cannot travel quoted needs the second parameter: an
  // all-ASCII name is already exactly what every client reads.
  it("leaves an ASCII filename with nothing but the quoted parameter", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "pressupost.pdf",
            mimeType: "application/pdf",
            content: Buffer.from("dades"),
          },
        ],
      }),
    );

    const attachment = part(multipart(sentRawMime(fetchMock)).parts[2]!.slice(2));
    expect(attachment.headers).toContain(
      'Content-Disposition: attachment; filename="pressupost.pdf"',
    );
    expect(attachment.headers).not.toContain("filename*=");
  });

  // The browser reports the type, so it is as untrusted as the name: anything
  // that is not a media type is sent as unspecified bytes.
  it("falls back to octet-stream when the reported type is not a media type", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "dades.bin",
            mimeType: "text/plain\r\nContent-Disposition: inline",
            content: Buffer.from("dades"),
          },
        ],
      }),
    );

    const attachment = part(multipart(sentRawMime(fetchMock)).parts[2]!.slice(2));
    expect(attachment.headers).toContain("Content-Type: application/octet-stream");
    expect(attachment.headers).not.toContain("Content-Disposition: inline");
  });

  // A reply with nothing attached stays the plain message it was: a multipart
  // wrapper around a single text part is noise every client has to unwrap.
  it("sends a reply with no files as a single text part", async () => {
    const fetchMock = gmailAccepts({ id: "sent-1" });

    await createGmailSender(ACCESS_TOKEN).sendReply(outgoingReply());

    const mime = sentRawMime(fetchMock);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).not.toContain("multipart/mixed");
  });

  it("fails loudly when Gmail refuses the send", async () => {
    gmailAccepts({ error: { message: "Insufficient Permission" } }, 403);

    await expect(
      createGmailSender(ACCESS_TOKEN).sendReply(outgoingReply()),
    ).rejects.toThrow(/Insufficient Permission/);
  });
});
