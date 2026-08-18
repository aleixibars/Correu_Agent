import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { WorkHandler } from "pg-boss";
import {
  generateThreadDraft,
  type DraftMessagesClient,
} from "@correu-agent/shared/drafts";
import type { ThreadAutoReplySender } from "../drafts/auto-reply";

/** Queue that writes the reply drafts of triaged threads (context.md §2). */
export const THREAD_DRAFT_QUEUE = "thread-draft";

/** Payload of a `thread-draft` job: which stored thread to answer, for which tenant. */
export type ThreadDraftJobData = {
  tenantId: string;
  threadId: string;
};

export type DraftedThreadResult = ThreadDraftJobData & {
  draftId: string;
  /** The language the reply was written in (context.md §6); null when unreported. */
  language: string | null;
  model: string;
  /** True when a category's auto-reply rule asked for this draft (context.md §2). */
  autoReply: boolean;
  /**
   * The outbound message the auto-reply was stored as. Null when the draft waits
   * for the dashboard, when the rule was switched off while the model was
   * writing, or when the send failed — the draft then stands as a pending one.
   */
  sentMessageId: string | null;
};

export type FailedThreadDraft = ThreadDraftJobData & { error: string };

export type ThreadDraftResult = {
  drafted: DraftedThreadResult[];
  /**
   * Threads that needed nothing: untriaged, never answered, already drafted, or
   * already replied to.
   */
  skipped: ThreadDraftJobData[];
  failed: FailedThreadDraft[];
};

export interface ThreadDraftDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  db: PgDatabase<T, TSchema>;
  anthropic: DraftMessagesClient;
  /** Sends the drafts an auto-reply rule asked for, with nobody approving them. */
  autoReply: ThreadAutoReplySender;
}

const targetKey = ({ tenantId, threadId }: ThreadDraftJobData): string =>
  `${tenantId}:${threadId}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Writes a draft for every thread named in the batch (context.md §2). A thread
 * that already has a draft for the mail that arrived is skipped rather than
 * answered twice.
 *
 * A batch can name the same thread twice (the tick queued a draft while the
 * previous one was still waiting), so targets are de-duplicated: drafting it
 * twice would only be paid for twice.
 */
export const createThreadDraftHandler = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>({
  db,
  anthropic,
  autoReply,
}: ThreadDraftDeps<T, TSchema>): WorkHandler<
  ThreadDraftJobData,
  ThreadDraftResult
> => {
  return async (jobs) => {
    const targets = new Map<string, ThreadDraftJobData>();
    for (const { data } of jobs) {
      const target: ThreadDraftJobData = {
        tenantId: data.tenantId,
        threadId: data.threadId,
      };
      targets.set(targetKey(target), target);
    }

    const drafted: DraftedThreadResult[] = [];
    const skipped: ThreadDraftJobData[] = [];
    const failed: FailedThreadDraft[] = [];

    // One thread at a time: a batch is small, and a thread the model choked on
    // must not take the rest of the batch with it.
    for (const target of targets.values()) {
      try {
        const result = await generateThreadDraft(db, anthropic, target);
        if (!result) {
          skipped.push(target);
          continue;
        }

        let sentMessageId: string | null = null;
        if (result.autoReply) {
          try {
            // The rule is read again inside the send, so a switch turned off
            // while the model was writing still stops the mail (context.md §2).
            const sent = await autoReply({ ...target, draftId: result.draftId });
            sentMessageId = sent?.sentMessageId ?? null;
          } catch (error) {
            // The draft itself is written and stands as a pending one the
            // dashboard can send by hand, so this is reported rather than
            // thrown: retrying the job would only draft the thread again.
            console.error(
              `Auto-replying to thread ${target.threadId} failed:`,
              error,
            );
            failed.push({ ...target, error: errorMessage(error) });
          }
        }

        drafted.push({
          ...target,
          draftId: result.draftId,
          language: result.language,
          model: result.model,
          autoReply: result.autoReply,
          sentMessageId,
        });
      } catch (error) {
        console.error(
          `Drafting a reply to thread ${target.threadId} failed:`,
          error,
        );
        failed.push({ ...target, error: errorMessage(error) });
      }
    }

    // A batch where everything failed is worth retrying: reporting success would
    // hide, say, an expired API key behind an empty result.
    if (drafted.length === 0 && skipped.length === 0 && failed.length > 0) {
      throw new Error(
        `Every thread in the batch failed to draft: ${failed
          .map(({ error }) => error)
          .join("; ")}`,
      );
    }

    return { drafted, skipped, failed };
  };
};
