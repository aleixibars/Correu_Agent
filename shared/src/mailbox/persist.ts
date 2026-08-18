// Turning what a poll found into rows (context.md §7): one thread per provider
// conversation, the full body of every message, and an audit entry for the mail
// that was really new. Triage is *not* touched here — a thread that already has
// a category keeps it when a reply arrives (context.md §4).

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry } from "../audit";
import { messages as messagesTable, threads } from "../db/schema";
import type { ProviderMessage } from "../mail/types";
import type { TriageCategory } from "../triage/taxonomy";

export interface PersistPolledMessagesInput {
  tenantId: string;
  mailboxAccountId: string;
  /** What the poll returned, in any order and possibly spanning several threads. */
  messages: ProviderMessage[];
  /** Stamp for mail the provider dated for us; defaults to the wall clock. */
  now?: Date;
}

/** One thread the poll wrote to, and what the pipeline needs to decide about it. */
export interface PersistedThread {
  threadId: string;
  providerThreadId: string;
  /** The thread's category, unchanged by this write; null while it is untriaged. */
  category: TriageCategory | null;
  /** Set once the thread has been triaged — a triaged thread is never re-triaged. */
  triagedAt: Date | null;
  /** True when this poll created the thread rather than appending to an open one. */
  threadCreated: boolean;
  /** Mail actually stored now; empty when the poll repeated messages already held. */
  newProviderMessageIds: string[];
}

const groupByThread = (
  messages: ProviderMessage[],
): Map<string, ProviderMessage[]> => {
  const grouped = new Map<string, ProviderMessage[]>();
  for (const message of messages) {
    const group = grouped.get(message.providerThreadId);
    if (group) group.push(message);
    else grouped.set(message.providerThreadId, [message]);
  }
  return grouped;
};

/**
 * Persists the mail of one mailbox poll, grouped into threads.
 *
 * Idempotent by design: a poll that died after writing is repeated from the same
 * cursor, so the same message reaches here twice. The uniqueness of
 * `(thread, provider message id)` settles it, and only the rows that were really
 * inserted are reported back — and audited.
 */
export const persistPolledMessages = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  {
    tenantId,
    mailboxAccountId,
    messages,
    now = new Date(),
  }: PersistPolledMessagesInput,
): Promise<PersistedThread[]> => {
  const persisted: PersistedThread[] = [];

  for (const [providerThreadId, threadMessages] of groupByThread(messages)) {
    const arrivals = threadMessages.map((message) => message.sentAt ?? now);
    const lastMessageAt = new Date(
      Math.max(...arrivals.map((arrival) => arrival.getTime())),
    );

    const [thread] = await db
      .insert(threads)
      .values({
        tenantId,
        mailboxAccountId,
        providerThreadId,
        subject: threadMessages[0]?.subject ?? null,
        lastMessageAt,
      })
      .onConflictDoUpdate({
        target: [threads.mailboxAccountId, threads.providerThreadId],
        // Deliberately narrow: `category` and `triagedAt` are left alone, so a
        // reply inside a triaged thread does not send it back through triage
        // (context.md §4). `$onUpdate` does not fire on a conflict path, so the
        // stamp is explicit.
        set: {
          // Mail can be polled out of order; the thread's clock only moves on.
          lastMessageAt: sql`greatest(${threads.lastMessageAt}, excluded.last_message_at)`,
          // The subject of a thread is the one it opened with, not the "Re:" of
          // whichever reply happened to be polled.
          subject: sql`coalesce(${threads.subject}, excluded.subject)`,
          updatedAt: now,
        },
      })
      .returning({
        id: threads.id,
        category: threads.category,
        triagedAt: threads.triagedAt,
        // Postgres' upsert tell: a row this statement inserted has no deleting
        // transaction, an updated one carries the one that replaced it.
        threadCreated: sql<boolean>`(xmax = 0)`,
      });

    if (!thread) {
      throw new Error(
        `Failed to persist thread ${providerThreadId} of mailbox ${mailboxAccountId}.`,
      );
    }

    const inserted = await db
      .insert(messagesTable)
      .values(
        threadMessages.map((message) => ({
          tenantId,
          threadId: thread.id,
          providerMessageId: message.providerMessageId,
          direction: message.direction,
          messageIdHeader: message.messageIdHeader,
          inReplyTo: message.inReplyTo,
          references: message.references,
          fromAddress: message.fromAddress,
          toAddresses: message.toAddresses,
          ccAddresses: message.ccAddresses,
          subject: message.subject,
          snippet: message.snippet,
          bodyText: message.bodyText,
          bodyHtml: message.bodyHtml,
          sentAt: message.sentAt ?? now,
        })),
      )
      .onConflictDoNothing({
        target: [messagesTable.threadId, messagesTable.providerMessageId],
      })
      .returning({ providerMessageId: messagesTable.providerMessageId });

    const newProviderMessageIds = inserted.map(
      ({ providerMessageId }) => providerMessageId,
    );

    // Mail the previous poll had already stored is not an arrival: auditing it
    // again would make one mail look like several.
    if (newProviderMessageIds.length > 0) {
      await recordAuditLogEntry(db, {
        action: "mail_received",
        tenantId,
        actor: { type: "system" },
        threadId: thread.id,
        providerMessageIds: newProviderMessageIds,
        threadCreated: thread.threadCreated,
      });
    }

    persisted.push({
      threadId: thread.id,
      providerThreadId,
      category: thread.category,
      triagedAt: thread.triagedAt,
      threadCreated: thread.threadCreated,
      newProviderMessageIds,
    });
  }

  return persisted;
};
