// The RFC 5322 headers that make a draft land inside its thread instead of
// opening a new one (context.md §4). Derived from the message being answered,
// not from anything the model wrote.

/** The stored message a draft replies to, as far as threading is concerned. */
export interface ReplyParentMessage {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
}

export interface ReplyHeaders {
  inReplyTo: string | null;
  /** Space-separated message ids, oldest first — the thread's chain. */
  references: string | null;
}

const messageIds = (references: string | null): string[] =>
  references?.split(/\s+/).filter(Boolean) ?? [];

/**
 * Builds the threading headers of a reply to `parent` (RFC 5322 §3.6.4):
 * `In-Reply-To` names the parent, and `References` is the chain the parent
 * carried with the parent appended.
 *
 * Mail that arrived without a `Message-ID` leaves both alone rather than
 * inventing one: a reply that points at nothing still reads as a reply, while a
 * fabricated id breaks every client's threading.
 */
export const buildReplyHeaders = (parent: ReplyParentMessage): ReplyHeaders => {
  // A parent with no References is the first mail of the thread — its own
  // In-Reply-To, when it has one, is the whole chain there is.
  const chain = messageIds(parent.references ?? parent.inReplyTo);

  if (!parent.messageIdHeader) {
    return {
      inReplyTo: null,
      references: chain.length > 0 ? chain.join(" ") : null,
    };
  }

  // A provider that already listed the parent in its own References must not
  // make it appear twice.
  const references = chain.includes(parent.messageIdHeader)
    ? chain
    : [...chain, parent.messageIdHeader];

  return { inReplyTo: parent.messageIdHeader, references: references.join(" ") };
};

/**
 * The subject of the reply: the thread's own, prefixed once. Mail that arrived
 * without a subject is answered without one too — inventing a subject for a
 * conversation the client sees as untitled only makes the reply look foreign.
 */
export const replySubject = (subject: string | null): string => {
  const trimmed = subject?.trim() ?? "";
  if (trimmed === "") return "";
  // Case-insensitive, and any of the local variants a client may already have
  // added ("RE:", "Re :"), so a thread does not grow a chain of prefixes.
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
};
