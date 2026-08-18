import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import { TRIAGE_MODEL, type TriageMessagesClient } from "./classify";
import { triageThread } from "./triage-thread";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";

const NOW = new Date("2026-01-02T10:00:00.000Z");

const createClient = (text = "comercial") => {
  const create = vi.fn(
    async () =>
      ({
        model: TRIAGE_MODEL,
        content: [{ type: "text", text }],
      }) as unknown as Anthropic.Message,
  );
  return { client: { create } as unknown as TriageMessagesClient, create };
};

/** In the column order the thread select asks for: subject, category, triagedAt. */
const threadRow = (triagedAt: string | null = null) => [
  "Pressupost",
  triagedAt ? "comercial" : null,
  triagedAt,
];

/** In the column order the message select asks for: from, subject, body, snippet. */
const messageRow = () => [
  "client@example.com",
  "Pressupost",
  "Voldríem un pressupost.",
  "Voldríem un pressupost",
];

const createDb = ({
  thread = threadRow(),
  messages = [messageRow()],
  updated = [[THREAD_ID]] as unknown[][],
}: {
  thread?: unknown[] | null;
  messages?: unknown[][];
  updated?: unknown[][];
} = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "threads"')) return { rows: thread ? [thread] : [] };
    if (sql.includes('from "messages"')) return { rows: messages };
    if (sql.includes('update "threads"')) return { rows: updated };
    return { rows: [] };
  });
  return { db, queries };
};

const shape = (sql: string): string => {
  if (sql.includes('from "threads"')) return "load thread";
  if (sql.includes('from "messages"')) return "load messages";
  if (sql.includes('update "threads"')) return "store category";
  if (sql.includes('insert into "audit_log_entries"')) return "audit";
  return "other";
};

describe("triageThread", () => {
  it("stores the category the model chose and audits it", async () => {
    const { db, queries } = createDb();
    const { client, create } = createClient("suport");

    const result = await triageThread(db, client, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      now: NOW,
    });

    expect(result).toEqual({
      threadId: THREAD_ID,
      category: "suport",
      model: TRIAGE_MODEL,
    });
    expect(queries.map(({ sql }) => shape(sql))).toEqual([
      "load thread",
      "load messages",
      "store category",
      "audit",
    ]);
    // The stored mail is what the model reads: the thread is not re-fetched
    // from the provider at triage time (context.md §7).
    expect(create).toHaveBeenCalledOnce();

    const update = queries.find(({ sql }) => sql.includes('update "threads"'))!;
    expect(update.params).toContain("suport");
    expect(update.params).toContain(NOW.toISOString());
    // Only while it is untriaged: two workers must not both triage one thread.
    expect(update.sql).toContain('"triaged_at" is null');

    const audit = queries.find(({ sql }) =>
      sql.includes('insert into "audit_log_entries"'),
    )!;
    expect(audit.params).toContain("thread_classified");
    expect(audit.params).toContain(THREAD_ID);
    expect(JSON.stringify(audit.params)).toContain(TRIAGE_MODEL);
  });

  it("leaves an already triaged thread alone", async () => {
    // A reply inside a triaged thread never sends it back through triage
    // (context.md §4).
    const { db, queries } = createDb({
      thread: threadRow("2026-01-01T09:00:00.000Z"),
    });
    const { client, create } = createClient();

    await expect(
      triageThread(db, client, { tenantId: TENANT_ID, threadId: THREAD_ID }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(queries.map(({ sql }) => shape(sql))).toEqual(["load thread"]);
  });

  it("does nothing for a thread that is gone", async () => {
    const { db } = createDb({ thread: null });
    const { client, create } = createClient();

    await expect(
      triageThread(db, client, { tenantId: TENANT_ID, threadId: THREAD_ID }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not audit a classification another worker got in first with", async () => {
    // The update is guarded on `triaged_at is null`, so the loser of the race
    // writes nothing — and an audit entry would claim a category it did not set.
    const { db, queries } = createDb({ updated: [] });
    const { client } = createClient();

    await expect(
      triageThread(db, client, { tenantId: TENANT_ID, threadId: THREAD_ID }),
    ).resolves.toBeNull();
    expect(queries.map(({ sql }) => shape(sql))).not.toContain("audit");
  });

  it("classifies a thread whose mail is only a subject", async () => {
    const { db } = createDb({ messages: [] });
    const { client, create } = createClient("newsletter");

    await expect(
      triageThread(db, client, { tenantId: TENANT_ID, threadId: THREAD_ID }),
    ).resolves.toMatchObject({ category: "newsletter" });
    expect(create).toHaveBeenCalledOnce();
  });
});
