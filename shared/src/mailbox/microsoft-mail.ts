// Reading new mail out of a connected Microsoft 365 mailbox, for the 2-minute
// poll (context.md §8). The worker never calls Graph itself: it goes through
// this client so Gmail and Graph stay swappable behind one message shape.

import type { MailboxMessageSummary } from "./messages";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const INBOX_URL = `${GRAPH_BASE_URL}/me/mailFolders/inbox/messages`;

/** Only what a poll hands on; the body is fetched when the message is persisted. */
const MESSAGE_FIELDS =
  "id,conversationId,internetMessageId,subject,receivedDateTime,isDraft";

interface GraphMessage {
  id?: string;
  conversationId?: string;
  internetMessageId?: string | null;
  subject?: string | null;
  receivedDateTime?: string;
  isDraft?: boolean;
  /** Present on a delta entry that reports a deletion rather than a message. */
  "@removed"?: { reason?: string };
}

interface GraphPage {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
  error?: { code?: string; message?: string };
}

export interface MicrosoftMailboxSync {
  /** New mail, oldest first, de-duplicated across pages. */
  messages: MailboxMessageSummary[];
  /** Where the next poll resumes from — persisted in `mailbox_accounts.sync_cursor`. */
  deltaLink: string;
}

export interface MicrosoftNewMessagesRequest {
  accessToken: string;
  /** The stored delta link; absent the first time a mailbox is polled. */
  deltaLink?: string | null;
  /** Mail at or before this instant is not the product's business (context.md §4). */
  since: Date;
  fetch?: typeof globalThis.fetch;
}

/**
 * `URLSearchParams` would spell a space as `+`, and Graph reads a `+` inside an
 * OData `$filter` literally instead of as a separator.
 */
const query = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

const readPage = async (
  url: string,
  accessToken: string,
  fetch: typeof globalThis.fetch,
): Promise<GraphPage> => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  let body: GraphPage;
  try {
    body = (await response.json()) as GraphPage;
  } catch {
    throw new Error(
      `Microsoft Graph returned a non-JSON response (${response.status}).`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Microsoft Graph mail request failed: ${body.error?.code ?? response.status}${
        body.error?.message ? ` — ${body.error.message}` : ""
      }`,
    );
  }

  return body;
};

const toSummary = (
  message: GraphMessage,
  since: Date,
): MailboxMessageSummary | null => {
  // A deletion, a draft this mailbox is writing itself, or an entry too thin to
  // identify: none of them is incoming mail to triage.
  if (message["@removed"] || message.isDraft) return null;
  if (!message.id || !message.conversationId || !message.receivedDateTime) {
    return null;
  }

  const receivedAt = new Date(message.receivedDateTime);
  if (Number.isNaN(receivedAt.getTime()) || receivedAt <= since) return null;

  return {
    providerMessageId: message.id,
    providerThreadId: message.conversationId,
    messageIdHeader: message.internetMessageId ?? null,
    subject: message.subject ?? null,
    receivedAt,
  };
};

/**
 * Walks a paged Graph collection from `url`, collecting the messages worth
 * triaging. Returns the delta link of the last page when there is one — a
 * plain (non-delta) collection ends without one.
 */
const readCollection = async (
  url: string,
  { accessToken, since, fetch }: { accessToken: string; since: Date; fetch: typeof globalThis.fetch },
): Promise<{ messages: Map<string, MailboxMessageSummary>; deltaLink?: string }> => {
  // Graph repeats a message across pages when it changes mid-enumeration, and a
  // delta reports an already-seen message again when a flag on it changes.
  const messages = new Map<string, MailboxMessageSummary>();
  let next: string | undefined = url;
  let deltaLink: string | undefined;

  // Every page has to be followed: stopping early on a delta would drop the
  // cursor, and the next poll would start over from the current state, silently
  // skipping everything in between.
  while (next) {
    const page: GraphPage = await readPage(next, accessToken, fetch);
    for (const message of page.value ?? []) {
      const summary = toSummary(message, since);
      if (summary) messages.set(summary.providerMessageId, summary);
    }
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
    next = page["@odata.nextLink"];
  }

  return { messages, deltaLink };
};

/**
 * New mail since the last poll, plus the cursor the next one resumes from.
 *
 * A mailbox with no cursor yet asks for `$deltatoken=latest`, which hands back a
 * cursor without enumerating the inbox — the backlog is deliberately not
 * processed (context.md §4). Mail that landed between connecting the mailbox
 * and this first poll is not in that delta, so it is caught up with a filtered
 * list; the cursor is taken *before* the catch-up, so a message arriving
 * between the two calls is reported twice rather than lost.
 */
export const fetchMicrosoftNewMessages = async ({
  accessToken,
  deltaLink,
  since,
  fetch = globalThis.fetch,
}: MicrosoftNewMessagesRequest): Promise<MicrosoftMailboxSync> => {
  const options = { accessToken, since, fetch };

  if (deltaLink) {
    const delta = await readCollection(deltaLink, options);
    if (!delta.deltaLink) {
      throw new Error("Microsoft Graph returned no delta link for the inbox.");
    }
    return {
      messages: sortedByArrival(delta.messages),
      deltaLink: delta.deltaLink,
    };
  }

  const cursor = await readCollection(
    `${INBOX_URL}/delta?${query({
      $deltatoken: "latest",
      $select: MESSAGE_FIELDS,
    })}`,
    options,
  );
  if (!cursor.deltaLink) {
    throw new Error("Microsoft Graph returned no delta link for the inbox.");
  }

  const catchUp = await readCollection(
    `${INBOX_URL}?${query({
      $select: MESSAGE_FIELDS,
      // Graph wants the filtered property to be the sorted one too.
      $filter: `receivedDateTime gt ${since.toISOString()}`,
      $orderby: "receivedDateTime",
    })}`,
    options,
  );

  return {
    messages: sortedByArrival(catchUp.messages),
    deltaLink: cursor.deltaLink,
  };
};

const sortedByArrival = (
  messages: Map<string, MailboxMessageSummary>,
): MailboxMessageSummary[] =>
  [...messages.values()].sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
  );
