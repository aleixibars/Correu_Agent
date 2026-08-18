// The mail a draft is written from (context.md §7), read the same way whether
// the draft is the thread's first or the one that replaces a rejected draft.

import { desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { messages } from "../db/schema";
import { MAX_THREAD_MESSAGES } from "./generate";

/** One stored message, with the columns the prompt and the reply headers need. */
export interface StoredThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
}

/**
 * The last messages of a thread, **newest first** — that is the end a reply
 * answers, and the end the model reads. The prompt renders mail oldest first,
 * so callers reverse what they hand over.
 */
export const loadThreadMessages = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  threadId: string,
): Promise<StoredThreadMessage[]> =>
  db
    .select({
      id: messages.id,
      direction: messages.direction,
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      bodyText: messages.bodyText,
      snippet: messages.snippet,
      messageIdHeader: messages.messageIdHeader,
      inReplyTo: messages.inReplyTo,
      references: messages.references,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.sentAt))
    .limit(MAX_THREAD_MESSAGES);
