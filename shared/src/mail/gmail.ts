// Gmail side of the polling loop (context.md §8): every 2 minutes the worker
// asks the Gmail API what changed since the mailbox's stored `historyId` and
// hands the new messages back in the provider-agnostic shape of `./types`.

import type {
  MailPollResult,
  MailProviderClient,
  ProviderMessage,
} from "./types";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail labels that decide what a message is, rather than how it looks. */
const DRAFT_LABEL = "DRAFT";
const SENT_LABEL = "SENT";

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

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const errorDetail = (body: Record<string, unknown>): string => {
  const { error } = body;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "unknown error";
};

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
  if (labelIds.includes(DRAFT_LABEL)) return null;

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

/**
 * A Gmail client bound to one mailbox's access token. Refreshing that token is
 * the caller's job — the client is short-lived, one poll long.
 */
export const createGmailClient = (accessToken: string): MailProviderClient => ({
  async fetchNewMessages(cursor: string | null): Promise<MailPollResult> {
    // A mailbox with no cursor has nothing to resume from, and the backlog is
    // never imported (context.md §4): it starts watching from now.
    if (!cursor) {
      return { messages: [], cursor: await currentHistoryId(accessToken), cursorReset: true };
    }

    const messageIds = new Set<string>();
    // Where a truncated poll resumes from: the last record taken in full, never
    // the page's `historyId` (that one is the mailbox's current position, so it
    // would skip whatever this poll left behind).
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

      // Gmail keeps history for about a week; past that the cursor is gone and
      // the only honest answer is to restart from now.
      if (!page) {
        return {
          messages: [],
          cursor: await currentHistoryId(accessToken),
          cursorReset: true,
        };
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
      cursor: truncated && lastRecordId ? lastRecordId : latestHistoryId,
      cursorReset: false,
    };
  },
});
