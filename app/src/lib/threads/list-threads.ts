// Llista de fils del tauler (context.md §2): què ha arribat, com s'ha classificat
// i què n'espera el revisor. Fora del Server Component perquè la consulta es
// pugui provar sense arrencar Next.

import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TriageCategory } from "@correu-agent/shared";
import { drafts, threads } from "@correu-agent/shared/db/schema";
import type { DraftStatus } from "@correu-agent/shared/db/schema";
import { threadStatus, type ThreadStatus } from "./thread-status";

export interface ThreadListItem {
  id: string;
  subject: string | null;
  /** Null only while the triage tick has not reached the thread yet. */
  category: TriageCategory | null;
  lastMessageAt: Date | null;
  status: ThreadStatus;
}

export interface ListThreadsOptions {
  tenantId: string;
  /** How many threads the page reads; the PoC dashboard has no pagination yet. */
  limit?: number;
}

export const DEFAULT_THREAD_LIST_LIMIT = 50;

/**
 * The draft that still says something about the thread. A regeneration
 * supersedes the draft it replaces (context.md §2), so those are skipped —
 * otherwise a regenerated thread would read as if nothing had happened since.
 */
const liveDraftStatus = sql<DraftStatus | null>`(
  select ${drafts.status}
  from ${drafts}
  where ${and(eq(drafts.threadId, threads.id), ne(drafts.status, "superseded"))}
  order by ${desc(drafts.createdAt)}
  limit 1
)`;

export const listThreads = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  { tenantId, limit = DEFAULT_THREAD_LIST_LIMIT }: ListThreadsOptions,
): Promise<ThreadListItem[]> => {
  const rows = await db
    .select({
      id: threads.id,
      subject: threads.subject,
      category: threads.category,
      triagedAt: threads.triagedAt,
      lastMessageAt: threads.lastMessageAt,
      draftStatus: liveDraftStatus,
    })
    .from(threads)
    .where(eq(threads.tenantId, tenantId))
    // Newest mail first: the reviewer works the top of the list. `nulls last`
    // because Postgres sorts nulls first on a descending order, and a thread
    // stored before its mail — the only way the date is missing — would
    // otherwise sit pinned above today's mail.
    .orderBy(sql`${threads.lastMessageAt} desc nulls last`)
    .limit(limit);

  return rows.map(({ triagedAt, draftStatus, ...thread }) => ({
    ...thread,
    status: threadStatus({ triagedAt, draftStatus }),
  }));
};
