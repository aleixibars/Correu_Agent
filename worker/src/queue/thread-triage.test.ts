import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { TRIAGE_MODEL, type TriageMessagesClient } from "@correu-agent/shared/triage";
import {
  URGENT_NOTIFICATION_PATH,
  URGENT_TITLE,
  type WebPushSender,
} from "@correu-agent/shared/web-push";
import {
  THREAD_TRIAGE_QUEUE,
  createThreadTriageHandler,
  type QueueThreadDraft,
  type ThreadTriageJobData,
} from "./thread-triage";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_THREAD_ID = "33333333-3333-3333-3333-333333333333";

const job = (data: ThreadTriageJobData, id = "job-1"): Job<ThreadTriageJobData> =>
  ({ id, name: THREAD_TRIAGE_QUEUE, data }) as Job<ThreadTriageJobData>;

/** In the column order `triageThread` selects: subject, category, triagedAt. */
const threadRow = (triagedAt: string | null = null) => [
  "Pressupost",
  triagedAt ? "comercial" : null,
  triagedAt,
];

const messageRow = () => [
  "client@example.com",
  "Pressupost",
  "Voldríem un pressupost.",
  "Voldríem un pressupost",
];

const PUSH_SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "client-public-key", auth: "client-auth-secret" },
};

const createDb = (
  threads: unknown[][] = [threadRow()],
  subscriptions: unknown[][] = [],
) => {
  let loads = 0;
  let updates = 0;
  return drizzle(async (sql) => {
    if (sql.includes('from "push_subscriptions"')) return { rows: subscriptions };
    // The urgent notification reads the thread back joined to its mail, which
    // is a different shape from the one `triageThread` loads.
    if (sql.includes('left join "messages"')) {
      return { rows: [["Servidor caigut", "client@example.com"]] };
    }
    if (sql.includes('from "threads"')) {
      const thread = threads[loads++];
      return { rows: thread ? [thread] : [] };
    }
    if (sql.includes('from "messages"')) return { rows: [messageRow()] };
    // The guarded update reports the thread it really triaged.
    if (sql.includes('update "threads"')) return { rows: [[`thread-${updates++}`]] };
    return { rows: [] };
  });
};

const createSender = () =>
  vi.fn<WebPushSender>(async () => ({ statusCode: 201, expired: false }));

const createQueueThreadDraft = () =>
  vi.fn<QueueThreadDraft>(async () => "job-id");

const createClient = (answers: string[] = ["comercial"]) => {
  let calls = 0;
  const create = vi.fn(async () => {
    const text = answers[calls++] ?? answers[answers.length - 1]!;
    if (text === "boom") throw new Error("Anthropic is down");
    return {
      model: TRIAGE_MODEL,
      content: [{ type: "text", text }],
    } as unknown as Anthropic.Message;
  });
  return { client: { create } as unknown as TriageMessagesClient, create };
};

describe("createThreadTriageHandler", () => {
  it("classifies every thread in the batch", async () => {
    const { client } = createClient(["comercial", "urgent"]);

    const result = await createThreadTriageHandler({
      db: createDb([threadRow(), threadRow()]),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft: createQueueThreadDraft(),
    })([
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      job({ tenantId: TENANT_ID, threadId: OTHER_THREAD_ID }, "job-2"),
    ]);

    expect(result.triaged).toEqual([
      {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        category: "comercial",
        model: TRIAGE_MODEL,
      },
      {
        tenantId: TENANT_ID,
        threadId: OTHER_THREAD_ID,
        category: "urgent",
        model: TRIAGE_MODEL,
      },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("classifies a thread named twice in one batch only once", async () => {
    const { client, create } = createClient();

    const result = await createThreadTriageHandler({
      db: createDb(),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft: createQueueThreadDraft(),
    })([
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }, "job-2"),
    ]);

    // Classifying the same thread twice would only pay Anthropic twice.
    expect(create).toHaveBeenCalledOnce();
    expect(result.triaged).toHaveLength(1);
  });

  it("reports a thread that was already triaged as skipped", async () => {
    const { client, create } = createClient();

    const result = await createThreadTriageHandler({
      db: createDb([threadRow("2026-01-01T09:00:00.000Z")]),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft: createQueueThreadDraft(),
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(result.skipped).toEqual([{ tenantId: TENANT_ID, threadId: THREAD_ID }]);
    expect(result.triaged).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps triaging the batch after one thread fails", async () => {
    const { client } = createClient(["boom", "suport"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createThreadTriageHandler({
      db: createDb([threadRow(), threadRow()]),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft: createQueueThreadDraft(),
    })([
      job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      job({ tenantId: TENANT_ID, threadId: OTHER_THREAD_ID }, "job-2"),
    ]);

    expect(result.failed).toEqual([
      {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        error: "Anthropic is down",
      },
    ]);
    expect(result.triaged).toHaveLength(1);
    error.mockRestore();
  });

  it("fails the batch when nothing in it could be triaged", async () => {
    // An expired API key must not look like a batch of successfully triaged
    // threads, or pg-boss would never retry it.
    const { client } = createClient(["boom"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createThreadTriageHandler({
        db: createDb(),
        anthropic: client,
        webPush: createSender(),
        queueThreadDraft: createQueueThreadDraft(),
      })([
        job({ tenantId: TENANT_ID, threadId: THREAD_ID }),
      ]),
    ).rejects.toThrow("Anthropic is down");
    error.mockRestore();
  });
  it("pushes a thread classified as urgent to the subscribed browsers (context.md §5)", async () => {
    const { client } = createClient(["urgent"]);
    const webPush = createSender();

    await createThreadTriageHandler({
      db: createDb([threadRow()], [
        [
          PUSH_SUBSCRIPTION.endpoint,
          PUSH_SUBSCRIPTION.keys.p256dh,
          PUSH_SUBSCRIPTION.keys.auth,
        ],
      ]),
      anthropic: client,
      webPush,
      queueThreadDraft: createQueueThreadDraft(),
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(webPush).toHaveBeenCalledWith(
      PUSH_SUBSCRIPTION,
      expect.objectContaining({
        title: URGENT_TITLE,
        body: "client@example.com: Servidor caigut",
        url: URGENT_NOTIFICATION_PATH,
      }),
    );
  });

  // Everything that is not urgent waits for the daily digest (context.md §5).
  it("pushes nothing for any other category", async () => {
    const { client } = createClient(["comercial"]);
    const webPush = createSender();

    await createThreadTriageHandler({
      db: createDb([threadRow()], [
        [
          PUSH_SUBSCRIPTION.endpoint,
          PUSH_SUBSCRIPTION.keys.p256dh,
          PUSH_SUBSCRIPTION.keys.auth,
        ],
      ]),
      anthropic: client,
      webPush,
      queueThreadDraft: createQueueThreadDraft(),
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(webPush).not.toHaveBeenCalled();
  });

  // The category is already stored by the time the push is attempted, so a
  // failing notification must not turn a classified thread into a failed job.
  it("still reports the thread as triaged when the notification fails", async () => {
    const { client } = createClient(["urgent"]);
    const webPush = createSender();
    webPush.mockRejectedValue(new Error("push service unreachable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createThreadTriageHandler({
      db: createDb([threadRow()], [
        [
          PUSH_SUBSCRIPTION.endpoint,
          PUSH_SUBSCRIPTION.keys.p256dh,
          PUSH_SUBSCRIPTION.keys.auth,
        ],
      ]),
      anthropic: client,
      webPush,
      queueThreadDraft: createQueueThreadDraft(),
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(result.triaged).toHaveLength(1);
    expect(result.failed).toEqual([]);
    error.mockRestore();
  });

  it("queues immediate drafting for a thread classified into a draft-eligible category (context.md §2, §8)", async () => {
    const { client } = createClient(["comercial"]);
    const queueThreadDraft = createQueueThreadDraft();

    await createThreadTriageHandler({
      db: createDb(),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft,
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    // Same singleton key as the 2-minute schedule (`drafts/schedule.ts`) so a
    // job it already queued is not stacked behind a duplicate.
    expect(queueThreadDraft).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });
  });

  it("does not queue drafting for a thread classified as newsletter", async () => {
    const { client } = createClient(["newsletter"]);
    const queueThreadDraft = createQueueThreadDraft();

    await createThreadTriageHandler({
      db: createDb(),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft,
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(queueThreadDraft).not.toHaveBeenCalled();
  });

  it("does not queue drafting for a thread that was skipped (already triaged)", async () => {
    const { client } = createClient();
    const queueThreadDraft = createQueueThreadDraft();

    await createThreadTriageHandler({
      db: createDb([threadRow("2026-01-01T09:00:00.000Z")]),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft,
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(queueThreadDraft).not.toHaveBeenCalled();
  });

  it("reports and swallows an error queuing the immediate draft, leaving the triage result unaffected", async () => {
    const { client } = createClient(["comercial"]);
    const queueThreadDraft = vi.fn<QueueThreadDraft>(async () => {
      throw new Error("queue is down");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // The safety net (`drafts/schedule.ts`'s own 2-minute tick) still picks
    // this thread up, so a queueing failure here must not fail the triage job.
    const result = await createThreadTriageHandler({
      db: createDb(),
      anthropic: client,
      webPush: createSender(),
      queueThreadDraft,
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(result.triaged).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(THREAD_ID),
      expect.anything(),
    );
    error.mockRestore();
  });

  // Auto-discard (context.md §2, §4) is wired inside `triageThread` itself
  // (`@correu-agent/shared/triage`), not here — this is the end-to-end proof
  // that the handler carries it through: no push for a non-urgent category, and
  // a `discarded` draft written straight from triage, with no Sonnet call.
  it("discards a newsletter thread automatically, with no push and no draft written any other way", async () => {
    const { client } = createClient(["newsletter"]);
    const webPush = createSender();
    const queueThreadDraft = createQueueThreadDraft();
    const queries: { sql: string }[] = [];
    const db = drizzle(async (sql) => {
      queries.push({ sql });
      if (sql.includes('from "push_subscriptions"')) return { rows: [] };
      if (sql.includes('left join "messages"')) {
        return { rows: [["El nostre butlletí", "newsletter@example.com"]] };
      }
      if (sql.includes('from "threads"')) return { rows: [threadRow()] };
      if (sql.includes('from "messages"')) return { rows: [messageRow()] };
      if (sql.includes('update "threads"')) return { rows: [["thread-0"]] };
      // No row stored: newsletter is discarded automatically by default.
      if (sql.includes('from "auto_discard_rules"')) return { rows: [] };
      if (sql.includes('insert into "drafts"')) return { rows: [["draft-1"]] };
      return { rows: [] };
    });

    const result = await createThreadTriageHandler({
      db,
      anthropic: client,
      webPush,
      queueThreadDraft,
    })([job({ tenantId: TENANT_ID, threadId: THREAD_ID })]);

    expect(queueThreadDraft).not.toHaveBeenCalled();
    expect(result.triaged).toEqual([
      {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        category: "newsletter",
        model: TRIAGE_MODEL,
      },
    ]);
    expect(webPush).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => sql.includes('insert into "drafts"'))).toBe(
      true,
    );
  });
});
