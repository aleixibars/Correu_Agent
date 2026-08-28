// Reading new mail out of a connected Microsoft 365 mailbox, for the 2-minute
// poll (context.md §8). The worker never calls Graph itself: it goes through
// this client so Gmail and Graph stay swappable behind one message shape.

import type {
  MailSenderClient,
  OutgoingReply,
  ProviderMessage,
  SentReply,
} from "../mail/types";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const INBOX_URL = `${GRAPH_BASE_URL}/me/mailFolders/inbox/messages`;
const MESSAGES_URL = `${GRAPH_BASE_URL}/me/messages`;

/**
 * Everything a message row needs (context.md §7): the body travels with the poll
 * so persisting it does not cost a second Graph call per message.
 */
const MESSAGE_FIELDS =
  "id,conversationId,internetMessageId,subject,receivedDateTime,isDraft,from,sender,toRecipients,ccRecipients,bodyPreview,body";

interface GraphRecipient {
  emailAddress?: { address?: string | null } | null;
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  internetMessageId?: string | null;
  subject?: string | null;
  receivedDateTime?: string;
  isDraft?: boolean;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  /** Present on a delta entry that reports a deletion rather than a message. */
  "@removed"?: { reason?: string };
}

/** The error envelope Graph answers a refused request with, on any endpoint. */
interface GraphError {
  error?: { code?: string; message?: string };
}

interface GraphPage extends GraphError {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface MicrosoftMailboxSync {
  /** New mail, oldest first, de-duplicated across pages. */
  messages: ProviderMessage[];
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

const nonJsonError = (status: number): Error =>
  new Error(`Microsoft Graph returned a non-JSON response (${status}).`);

/**
 * Graph names what it refused in the body; the status is the fallback for a
 * refusal that arrived without one. Shared by the read and write paths so both
 * surface a failure the same way.
 */
const requestFailed = (status: number, body: GraphError | null): Error =>
  new Error(
    `Microsoft Graph mail request failed: ${body?.error?.code ?? status}${
      body?.error?.message ? ` — ${body.error.message}` : ""
    }`,
  );

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
    throw nonJsonError(response.status);
  }

  if (!response.ok) throw requestFailed(response.status, body);

  return body;
};

const address = (recipient: GraphRecipient | null | undefined): string | null => {
  const value = recipient?.emailAddress?.address?.trim().toLowerCase();
  return value ? value : null;
};

const addresses = (recipients: GraphRecipient[] | undefined): string[] =>
  (recipients ?? [])
    .map(address)
    .filter((value): value is string => value !== null);

const toProviderMessage = (
  message: GraphMessage,
  since: Date,
): ProviderMessage | null => {
  // A deletion, a draft this mailbox is writing itself, or an entry too thin to
  // identify: none of them is incoming mail to triage.
  if (message["@removed"] || message.isDraft) return null;
  if (!message.id || !message.conversationId || !message.receivedDateTime) {
    return null;
  }

  const receivedAt = new Date(message.receivedDateTime);
  if (Number.isNaN(receivedAt.getTime()) || receivedAt <= since) return null;

  const isHtml = message.body?.contentType?.toLowerCase() === "html";
  const content = message.body?.content ?? null;

  return {
    providerMessageId: message.id,
    providerThreadId: message.conversationId,
    // Only the inbox is read, so everything a poll brings back arrived here.
    direction: "inbound",
    messageIdHeader: message.internetMessageId ?? null,
    // Graph only carries In-Reply-To/References inside `internetMessageHeaders`,
    // which the delta endpoint does not serve; a reply to a Graph conversation
    // is threaded by `conversationId` instead.
    inReplyTo: null,
    references: null,
    fromAddress: address(message.from) ?? address(message.sender) ?? "",
    toAddresses: addresses(message.toRecipients),
    ccAddresses: addresses(message.ccRecipients),
    subject: message.subject ?? null,
    snippet: message.bodyPreview ?? null,
    bodyText: isHtml ? null : content,
    bodyHtml: isHtml ? content : null,
    // Graph dates a message by when the mailbox received it, which is the
    // instant the thread is ordered by.
    sentAt: receivedAt,
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
): Promise<{ messages: Map<string, ProviderMessage>; deltaLink?: string }> => {
  // Graph repeats a message across pages when it changes mid-enumeration, and a
  // delta reports an already-seen message again when a flag on it changes.
  const messages = new Map<string, ProviderMessage>();
  let next: string | undefined = url;
  let deltaLink: string | undefined;

  // Every page has to be followed: stopping early on a delta would drop the
  // cursor, and the next poll would start over from the current state, silently
  // skipping everything in between.
  while (next) {
    const page: GraphPage = await readPage(next, accessToken, fetch);
    for (const message of page.value ?? []) {
      const parsed = toProviderMessage(message, since);
      if (parsed) messages.set(parsed.providerMessageId, parsed);
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
  messages: Map<string, ProviderMessage>,
): ProviderMessage[] =>
  // `sentAt` is the arrival instant here, and never null: a message without a
  // usable `receivedDateTime` is dropped before it reaches this point.
  [...messages.values()].sort(
    (a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0),
  );

/**
 * A Graph request that writes. `readPage` is for enumerating the inbox; this one
 * posts and tolerates the empty body Graph answers a send with.
 */
const graphPost = async (
  url: string,
  accessToken: string,
  fetch: typeof globalThis.fetch,
  body?: unknown,
): Promise<GraphMessage> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // A successful send answers `202 Accepted` with no body at all.
  const text = await response.text();
  let parsed: (GraphMessage & GraphError) | null = null;
  if (text !== "") {
    try {
      parsed = JSON.parse(text) as GraphMessage & GraphError;
    } catch {
      if (response.ok) return {};
      throw nonJsonError(response.status);
    }
  }

  if (!response.ok) throw requestFailed(response.status, parsed);

  return parsed ?? {};
};

const recipients = (addresses: string[]): GraphRecipient[] =>
  addresses.map((address) => ({ emailAddress: { address } }));

/**
 * Sends the reply of an approved draft through Graph (context.md §2).
 *
 * Graph has no "send this MIME into that conversation" call, so the reply is
 * created *from* the message being answered — `createReply` is what keeps it in
 * the conversation, exactly as the RFC 5322 headers do on the Gmail side.
 * Recipients and subject are set explicitly rather than left to Graph's
 * defaults, so both providers send the same mail.
 */
export const createMicrosoftSender = ({
  accessToken,
  fetch = globalThis.fetch,
}: {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
}): MailSenderClient => ({
  async sendReply(reply: OutgoingReply): Promise<SentReply> {
    const draft = await graphPost(
      `${MESSAGES_URL}/${encodeURIComponent(reply.inReplyToProviderMessageId)}/createReply`,
      accessToken,
      fetch,
      {
        message: {
          subject: reply.subject,
          toRecipients: recipients(reply.toAddresses),
          ccRecipients: recipients(reply.ccAddresses),
          // Graph keeps the blind copies out of the delivered headers itself,
          // so they are sent as a field rather than written into the message.
          bccRecipients: recipients(reply.bccAddresses),
          body: { contentType: "Text", content: reply.bodyText },
        },
      },
    );

    if (!draft.id) {
      throw new Error("Microsoft Graph created no reply draft to send.");
    }

    await graphPost(
      `${MESSAGES_URL}/${encodeURIComponent(draft.id)}/send`,
      accessToken,
      fetch,
    );

    return {
      // The id of the draft that was sent. Graph can renumber a message when it
      // moves to Sent Items, but only the inbox is ever polled (context.md §4),
      // so this id is never matched against one the provider reports later.
      providerMessageId: draft.id,
      // The `Message-ID` is assigned when the draft is created, so it is already
      // the one the recipient will see.
      messageIdHeader: draft.internetMessageId ?? null,
    };
  },
});
