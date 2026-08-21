// Gmail side of the polling loop (context.md §8): every 2 minutes the worker
// asks the Gmail API what changed since the mailbox's stored `historyId` and
// hands the new messages back in the provider-agnostic shape of `./types`.

import { errorDetail, readJson } from "./google-errors";
import { buildReplyMime } from "./mime";
import type {
  MailPollResult,
  MailProviderClient,
  MailSenderClient,
  OutgoingReply,
  ProviderMessage,
  SentReply,
} from "./types";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail labels that decide what a message is, rather than how it looks. */
const DRAFT_LABEL = "DRAFT";
const SENT_LABEL = "SENT";
const TRASH_LABEL = "TRASH";

type GmailHeader = { name?: unknown; value?: unknown };

type GmailPart = {
  mimeType?: unknown;
  headers?: unknown;
  body?: { data?: unknown } | undefined;
  parts?: unknown;
};

type GmailMessage = GmailPart & {
  id?: unknown;
  threadId?: unknown;
  labelIds?: unknown;
  snippet?: unknown;
  internalDate?: unknown;
  payload?: GmailPart | undefined;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * `null` on 404 so the caller can tell "gone" apart from "broken": an expired
 * history cursor and a message deleted mid-poll are both normal, everything
 * else (auth, quota) has to surface as a failed job.
 */
const gmailGet = async (
  accessToken: string,
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<Record<string, unknown> | null> => {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });

  const body = await readJson(response);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Gmail refused ${path} (${response.status}): ${errorDetail(body)}`,
    );
  }
  return body;
};

const gmailPost = async (
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const answer = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `Gmail refused ${path} (${response.status}): ${errorDetail(answer)}`,
    );
  }
  return answer;
};

const headerValue = (headers: GmailHeader[], name: string): string | null => {
  const match = headers.find(
    (header) =>
      typeof header.name === "string" &&
      header.name.toLowerCase() === name.toLowerCase(),
  );
  return match ? asString(match.value) : null;
};

/**
 * Pulls the addresses out of an address header. Commas inside a quoted display
 * name (`"Ibars, Aleix" <a@example.com>`) do not separate addresses, so the
 * split tracks quotes and angle brackets instead of using `split(",")`.
 */
const parseAddressList = (value: string | null): string[] => {
  if (!value) return [];

  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;

  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (character === "<" && !quoted) angled = true;
    else if (character === ">" && !quoted) angled = false;

    if (character === "," && !quoted && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);

  return entries
    .map((entry) => parseAddress(entry))
    .filter((address): address is string => address !== null);
};

const parseAddress = (entry: string): string | null => {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const opening = trimmed.lastIndexOf("<");
  const closing = trimmed.lastIndexOf(">");
  const address =
    opening !== -1 && closing > opening
      ? trimmed.slice(opening + 1, closing)
      : trimmed;

  return address.trim().toLowerCase() || null;
};

const decodeBody = (data: unknown): string | null => {
  const encoded = asString(data);
  return encoded ? Buffer.from(encoded, "base64url").toString("utf8") : null;
};

/** First part of the wanted MIME type, walking nested multipart containers depth-first. */
const findBody = (part: GmailPart | undefined, mimeType: string): string | null => {
  if (!part) return null;

  if (part.mimeType === mimeType) {
    const decoded = decodeBody(part.body?.data);
    if (decoded !== null) return decoded;
  }

  for (const child of (Array.isArray(part.parts) ? part.parts : []) as GmailPart[]) {
    const found = findBody(child, mimeType);
    if (found !== null) return found;
  }
  return null;
};

const toProviderMessage = (message: GmailMessage): ProviderMessage | null => {
  const providerMessageId = asString(message.id);
  const providerThreadId = asString(message.threadId);
  if (!providerMessageId || !providerThreadId) return null;

  const labelIds = asStringArray(message.labelIds);
  // A draft the mailbox is writing itself is not mail that arrived, and mail
  // already in the bin is mail the owner threw away: neither is worth triaging.
  // The Graph client leaves both out too, by reading the inbox alone.
  if (labelIds.includes(DRAFT_LABEL) || labelIds.includes(TRASH_LABEL)) {
    return null;
  }

  const headers = (Array.isArray(message.payload?.headers)
    ? message.payload?.headers
    : []) as GmailHeader[];
  const internalDate = asString(message.internalDate);

  return {
    providerMessageId,
    providerThreadId,
    direction: labelIds.includes(SENT_LABEL) ? "outbound" : "inbound",
    messageIdHeader: headerValue(headers, "Message-ID"),
    inReplyTo: headerValue(headers, "In-Reply-To"),
    references: headerValue(headers, "References"),
    fromAddress: parseAddressList(headerValue(headers, "From"))[0] ?? "",
    toAddresses: parseAddressList(headerValue(headers, "To")),
    ccAddresses: parseAddressList(headerValue(headers, "Cc")),
    subject: headerValue(headers, "Subject"),
    snippet: asString(message.snippet),
    bodyText: findBody(message.payload, "text/plain"),
    bodyHtml: findBody(message.payload, "text/html"),
    sentAt: internalDate ? new Date(Number(internalDate)) : null,
  };
};

/** Gmail sends `historyId` as a string, but documents it as a uint64. */
const readHistoryId = (body: Record<string, unknown>): string | null =>
  typeof body.historyId === "number"
    ? String(body.historyId)
    : asString(body.historyId);

const currentHistoryId = async (accessToken: string): Promise<string> => {
  const profile = await gmailGet(accessToken, "/profile");
  const historyId = profile ? readHistoryId(profile) : null;
  if (!historyId) {
    throw new Error("Gmail returned no historyId to resume polling from.");
  }
  return historyId;
};

/**
 * One history record: its own id, which is where a later poll resumes from
 * (`startHistoryId` is exclusive), and the message ids it says were added.
 */
type HistoryRecord = { id: string | null; messageIds: string[] };

const historyRecords = (body: Record<string, unknown>): HistoryRecord[] =>
  ((Array.isArray(body.history) ? body.history : []) as Record<string, unknown>[]).map(
    (record) => {
      const messagesAdded = (
        Array.isArray(record.messagesAdded) ? record.messagesAdded : []
      ) as { message?: GmailMessage }[];

      const messageIds: string[] = [];
      for (const entry of messagesAdded) {
        const id = asString(entry.message?.id);
        // The full labels come from the message fetch; the history entry is only
        // trusted for "a draft was saved", which is never mail that arrived.
        const isDraft = asStringArray(entry.message?.labelIds).includes(DRAFT_LABEL);
        if (id && !isDraft) messageIds.push(id);
      }

      return { id: asString(record.id), messageIds };
    },
  );

/**
 * How much one poll takes on before it stops and leaves the rest for the next
 * tick. A mailbox that fell a long way behind (worker down for a day, a bulk
 * import) can have thousands of messages waiting, and each one costs a separate
 * Gmail fetch: without a bound the job would outlive pg-boss's expiry, be
 * retried from the same cursor, and the mailbox would never make progress
 * again. Stopping early is safe because the cursor moves with the work done.
 */
export const MAX_MESSAGES_PER_POLL = 200;

/** One page of `messages.list` — only the ids matter, the body is fetched separately. */
const messageRefIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? (value as { id?: unknown }[])
        .map((entry) => asString(entry?.id))
        .filter((id): id is string => id !== null)
    : [];

export interface GmailMailboxClient extends MailProviderClient {
  /**
   * One-time catch-up for a mailbox that just connected (context.md §4): mail
   * from earlier the same business day that arrived *before* the connection.
   * History (`fetchNewMessages`) only reports *changes* since a cursor, so it
   * cannot answer "what already existed" — a full-text search can.
   *
   * Not bounded by `MAX_MESSAGES_PER_POLL` like the incremental poll is: this
   * runs once, for one calendar day of one mailbox, never on the 2-minute
   * cadence where an unbounded backlog is the real risk.
   */
  fetchMessagesSince(afterEpochSeconds: number): Promise<{ messages: ProviderMessage[] }>;
}

/**
 * A Gmail client bound to one mailbox's access token. Refreshing that token is
 * the caller's job — the client is short-lived, one poll long.
 */
export const createGmailClient = (accessToken: string): GmailMailboxClient => ({
  async fetchNewMessages(cursor: string | null): Promise<MailPollResult> {
    // A mailbox with no cursor has nothing to resume from, and the backlog is
    // never imported (context.md §4): it starts watching from now.
    if (!cursor) {
      return { messages: [], cursor: await currentHistoryId(accessToken), cursorReset: true };
    }

    const messageIds = new Set<string>();
    // Where a poll that stopped early resumes from: the last record taken in
    // full, never the page's `historyId` (that one is the mailbox's current
    // position, so it would skip whatever this poll left behind).
    let lastRecordId: string | null = null;
    let latestHistoryId = cursor;
    let pageToken: string | undefined;
    let truncated = false;

    do {
      const page = await gmailGet(accessToken, "/history", {
        startHistoryId: cursor,
        historyTypes: "messageAdded",
        pageToken,
      });

      if (!page) {
        // On the first request the stored cursor itself is gone: Gmail keeps
        // history for about a week, and the only honest answer is to restart
        // from now.
        if (!pageToken) {
          return {
            messages: [],
            cursor: await currentHistoryId(accessToken),
            cursorReset: true,
          };
        }
        // On a later page the cursor was still good a moment ago, so this is a
        // page that went stale mid-poll. Keep what has already been taken and
        // resume from there; restarting from now would skip the rest of the
        // history this poll had not reached yet.
        truncated = true;
        break;
      }

      for (const record of historyRecords(page)) {
        for (const id of record.messageIds) messageIds.add(id);
        if (record.id) lastRecordId = record.id;
        // Checked after taking the record, not before: a single record holding
        // more than the cap must still be consumed, or the poll would stop
        // without moving the cursor and repeat itself forever.
        if (messageIds.size >= MAX_MESSAGES_PER_POLL) {
          truncated = true;
          break;
        }
      }

      latestHistoryId = readHistoryId(page) ?? latestHistoryId;
      pageToken = asString(page.nextPageToken) ?? undefined;
    } while (pageToken && !truncated);

    const messages: ProviderMessage[] = [];
    for (const id of messageIds) {
      const raw = await gmailGet(
        accessToken,
        `/messages/${encodeURIComponent(id)}`,
        { format: "full" },
      );
      // Deleted between the history page and this fetch — normal, not an error.
      if (!raw) continue;

      const message = toProviderMessage(raw as GmailMessage);
      if (message) messages.push(message);
    }

    return {
      messages,
      // A poll that ran to the end of the history is at the mailbox's current
      // position; one that stopped early is only as far as the last record it
      // took, and falls back to where it started rather than to a position it
      // never reached.
      cursor: truncated ? (lastRecordId ?? cursor) : latestHistoryId,
      cursorReset: false,
    };
  },

  async fetchMessagesSince(afterEpochSeconds: number): Promise<{ messages: ProviderMessage[] }> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    // `after:` is a Gmail search operator (a Unix timestamp is accepted), not
    // a history cursor — this walks `messages.list`, never `/history`.
    do {
      const page = await gmailGet(accessToken, "/messages", {
        q: `after:${afterEpochSeconds}`,
        pageToken,
      });
      if (!page) break;

      ids.push(...messageRefIds(page.messages));
      pageToken = asString(page.nextPageToken) ?? undefined;
    } while (pageToken);

    const messages: ProviderMessage[] = [];
    for (const id of ids) {
      const raw = await gmailGet(
        accessToken,
        `/messages/${encodeURIComponent(id)}`,
        { format: "full" },
      );
      // Deleted between the search and this fetch — normal, not an error.
      if (!raw) continue;

      const message = toProviderMessage(raw as GmailMessage);
      if (message) messages.push(message);
    }

    return { messages };
  },
});

/**
 * Sends the reply of an approved draft (context.md §2). `threadId` is what puts
 * the mail inside the conversation for Gmail's own threading; the RFC 5322
 * headers in the MIME are what put it there for every other client.
 *
 * The `Message-ID` Gmail stamps is deliberately not read back: that would be a
 * second call *after* the mail has left, and a failure there would be retried as
 * another send. The mail is out — nothing may run between the send and the row
 * that records it.
 */
export const createGmailSender = (accessToken: string): MailSenderClient => ({
  async sendReply(reply: OutgoingReply): Promise<SentReply> {
    const sent = await gmailPost(accessToken, "/messages/send", {
      raw: Buffer.from(buildReplyMime(reply), "utf8").toString("base64url"),
      threadId: reply.providerThreadId,
    });

    const providerMessageId = asString(sent.id);
    if (!providerMessageId) {
      throw new Error("Gmail accepted the reply but returned no message id.");
    }

    return { providerMessageId, messageIdHeader: null };
  },
});
