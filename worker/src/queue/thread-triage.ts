import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { WorkHandler } from "pg-boss";
import {
  triageThread,
  type TriageCategory,
  type TriageMessagesClient,
} from "@correu-agent/shared/triage";

/** Queue that classifies the threads the poll wrote to (context.md §4). */
export const THREAD_TRIAGE_QUEUE = "thread-triage";

/** Payload of a `thread-triage` job: which stored thread to classify, for which tenant. */
export type ThreadTriageJobData = {
  tenantId: string;
  threadId: string;
};

export type TriagedThreadResult = ThreadTriageJobData & {
  category: TriageCategory;
  model: string;
};

export type FailedThreadTriage = ThreadTriageJobData & { error: string };

export type ThreadTriageResult = {
  triaged: TriagedThreadResult[];
  /** Threads that needed nothing: already triaged, gone, or triaged by another worker. */
  skipped: ThreadTriageJobData[];
  failed: FailedThreadTriage[];
};

export interface ThreadTriageDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
  anthropic: TriageMessagesClient;
}

const targetKey = ({ tenantId, threadId }: ThreadTriageJobData): string =>
  `${tenantId}:${threadId}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Classifies every thread named in the batch (context.md §4). A thread that was
 * already triaged is skipped rather than classified again — a reply inside a
 * thread never changes what the thread is.
 *
 * A batch can name the same thread twice (the tick queued a triage while the
 * previous one was still waiting), so targets are de-duplicated: classifying it
 * twice would only be paid for twice.
 */
export const createThreadTriageHandler = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  db,
  anthropic,
}: ThreadTriageDeps<T, TSchema>): WorkHandler<
  ThreadTriageJobData,
  ThreadTriageResult
> => {
  return async (jobs) => {
    const targets = new Map<string, ThreadTriageJobData>();
    for (const { data } of jobs) {
      const target: ThreadTriageJobData = {
        tenantId: data.tenantId,
        threadId: data.threadId,
      };
      targets.set(targetKey(target), target);
    }

    const triaged: TriagedThreadResult[] = [];
    const skipped: ThreadTriageJobData[] = [];
    const failed: FailedThreadTriage[] = [];

    // One thread at a time: a batch is small, and a thread the model choked on
    // must not take the rest of the batch with it.
    for (const target of targets.values()) {
      try {
        const result = await triageThread(db, anthropic, target);
        if (result) {
          triaged.push({ ...target, category: result.category, model: result.model });
        } else {
          skipped.push(target);
        }
      } catch (error) {
        console.error(`Triaging thread ${target.threadId} failed:`, error);
        failed.push({ ...target, error: errorMessage(error) });
      }
    }

    // A batch where everything failed is worth retrying: reporting success would
    // hide, say, an expired API key behind an empty result.
    if (triaged.length === 0 && skipped.length === 0 && failed.length > 0) {
      throw new Error(
        `Every thread in the batch failed to triage: ${failed
          .map(({ error }) => error)
          .join("; ")}`,
      );
    }

    return { triaged, skipped, failed };
  };
};
