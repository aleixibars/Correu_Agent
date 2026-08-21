import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { WorkHandler } from "pg-boss";
import {
  needsDraft,
  triageThread,
  type TriageCategory,
  type TriageMessagesClient,
} from "@correu-agent/shared/triage";
import {
  notifyUrgentThread,
  type WebPushSender,
} from "@correu-agent/shared/web-push";
import type { ThreadDraftJobData } from "./thread-draft";

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

/**
 * Queues the immediate drafting of a thread just triaged into an eligible
 * category (context.md §2, §4): the same job and singleton key the 2-minute
 * schedule (`drafts/schedule.ts`) would queue on its next tick, sent right
 * away so triaged mail does not wait for that clock — the schedule itself
 * keeps running as the safety net for anything this misses.
 */
export type QueueThreadDraft = (target: ThreadDraftJobData) => Promise<unknown>;

export interface ThreadTriageDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
  anthropic: TriageMessagesClient;
  webPush: WebPushSender;
  queueThreadDraft: QueueThreadDraft;
}

const targetKey = ({ tenantId, threadId }: ThreadTriageJobData): string =>
  `${tenantId}:${threadId}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Classifies every thread named in the batch (context.md §4) and pushes the
 * urgent ones to the subscribed browsers (context.md §5). A thread that was
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
  webPush,
  queueThreadDraft,
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
          // Urgent is the only category that interrupts the user (context.md
          // §5). The category is already stored, so a push that fails is
          // reported and nothing else: retrying the job would find the thread
          // triaged and classify nothing.
          if (result.category === "urgent") {
            try {
              await notifyUrgentThread(db, webPush, target);
            } catch (error) {
              console.error(
                `Notifying the urgent thread ${target.threadId} failed:`,
                error,
              );
            }
          }
          // Newsletters and spam are archived, never answered (context.md
          // §2), so only an eligible category is worth drafting for. A failure
          // here is reported and nothing else: the category is already
          // stored, and `drafts/schedule.ts`'s own tick still picks the
          // thread up.
          if (needsDraft(result.category)) {
            try {
              await queueThreadDraft(target);
            } catch (error) {
              console.error(
                `Queuing immediate draft for thread ${target.threadId} failed:`,
                error,
              );
            }
          }
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
