import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { DRAFT_MODEL, type DraftMessagesClient } from "@correu-agent/shared/drafts";
import {
  THREAD_DRAFT_QUEUE,
  createThreadDraftHandler,
  type ThreadDraftJobData,
} from "./thread-draft";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_THREAD_ID = "33333333-3333-3333-3333-333333333333";

const job = (data: ThreadDraftJobData, id = "job-1"): Job<ThreadDraftJobData> =>
  ({ id, name: THREAD_DRAFT_QUEUE, data }) as Job<ThreadDraftJobData>;

/** In the column order `generateThreadDraft` selects: subject, category, triagedAt. */
const threadRow = (category: string | null = "comercial") => [
  "Pressupost",
  category,
  category ? "2026-01-02T09:00:00.000Z" : null,
];

const messageRow = () => [
  "message-1",
  "inbound",
  "client@example.com",
  "Pressupost",
  "Voldríem un pressupost.",
  "Voldríem un pressupost",
  "<client@mail.example.com>",
  null,
  null,
];

const createDb = (threads: unknown[][] = [threadRow()]) => {
  let loads = 0;
  let inserts = 0;
  return drizzle(async (sql) => {
    if (sql.includes('from "threads"')) {
      const thread = threads[loads++];
      return { rows: thread ? [thread] : [] };
    }
    if (sql.includes('from "messages"')) return { rows: [messageRow()] };
    if (sql.includes('from "drafts"')) return { rows: [] };
    if (sql.includes('insert into "drafts"')) return { rows: [[`draft-${inserts++}`]] };
    return { rows: [] };
  });
};

const createClient = (answers: string[] = ['{"language":"ca","body":"Bon dia."}']) => {
  let calls = 0;
  const create = vi.fn(async () => {
    const text = answers[calls++] ?? answers[answers.length - 1]!;
    if (text === "boom") throw new Error("Anthropic is down");
    return {
      model: DRAFT_MODEL,
      content: [{ type: "text", text }],
    } as unknown as Anthropic.Message;
  });
  return { client: { create } as unknown as DraftMessagesClient, create };
};

describe("createThreadDraftHandler", () => {
  it("drafts a reply for every thread in the batch", async () => {
    const { client } = createClient();

    const result = await createThreadDraftHandler({
      db: createDb([threadRow(), threadRow()]),
      anthropic: client,
    })([
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      job({ tenantId: TENANT_ID, threadId: OTHER_THREAD_ID }, "job-2"),
    ]);

    expect(result.drafted).toEqual([
      {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        draftId: "draft-0",
        language: "ca",
        model: DRAFT_MODEL,
      },
      {
        tenantId: TENANT_ID,
        threadId: OTHER_THREAD_ID,
        draftId: "draft-1",
        language: "ca",
        model: DRAFT_MODEL,
      },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("drafts a thread named twice in one batch only once", async () => {
    const { client, create } = createClient();

    const result = await createThreadDraftHandler({
      db: createDb(),
      anthropic: client,
    })([
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }, "job-2"),
    ]);

    // Drafting the same thread twice would only pay Anthropic twice.
    expect(create).toHaveBeenCalledOnce();
    expect(result.drafted).toHaveLength(1);
  });

  it("reports a thread that needs no reply as skipped", async () => {
    const { client, create } = createClient();

    const result = await createThreadDraftHandler({
      db: createDb([threadRow("newsletter")]),
      anthropic: client,
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(result.skipped).toEqual([{ tenantId: TENANT_ID, threadId: THREAD_ID }]);
    expect(result.drafted).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps drafting the batch after one thread fails", async () => {
    const { client } = createClient([
      "boom",
      '{"language":"es","body":"Buenos días."}',
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createThreadDraftHandler({
      db: createDb([threadRow(), threadRow()]),
      anthropic: client,
    })([
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      job({ tenantId: TENANT_ID, threadId: OTHER_THREAD_ID }, "job-2"),
    ]);

    expect(result.failed).toEqual([
      { tenantId: TENANT_ID, threadId: THREAD_ID, error: "Anthropic is down" },
    ]);
    expect(result.drafted).toHaveLength(1);
    error.mockRestore();
  });

  it("fails the batch when nothing in it could be drafted", async () => {
    // An expired API key must not look like a batch of drafted threads, or
    // pg-boss would never retry it.
    const { client } = createClient(["boom"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createThreadDraftHandler({ db: createDb(), anthropic: client })([
        job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      ]),
    ).rejects.toThrow("Anthropic is down");
    error.mockRestore();
  });
});
