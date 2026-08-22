import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { listThreads } from "./list-threads";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "55555555-5555-5555-5555-555555555555";
const DRAFT_ID = "66666666-6666-6666-6666-666666666666";

/**
 * Drizzle's proxy driver: the statement is built for real and captured instead
 * of reaching Postgres, so the test asserts on what would actually be queried.
 */
const recordingDatabase = (rows: unknown[][] = []) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    return { rows };
  });
  return { db, statements };
};

const row = (
  overrides: Partial<{
    id: string;
    subject: string | null;
    category: string | null;
    triagedAt: string | null;
    lastMessageAt: string | null;
    draftStatus: string | null;
    draftId: string | null;
  }> = {},
): unknown[] => {
  const values = {
    id: THREAD_ID,
    subject: "Pressupost",
    category: "comercial",
    triagedAt: "2026-08-18 09:00:00+00",
    lastMessageAt: "2026-08-18 08:30:00+00",
    draftStatus: null,
    draftId: null,
    ...overrides,
  };
  return [
    values.id,
    values.subject,
    values.category,
    values.triagedAt,
    values.lastMessageAt,
    values.draftStatus,
    values.draftId,
  ];
};

describe("listThreads", () => {
  it("reads only the threads of the tenant, newest mail first", async () => {
    const { db, statements } = recordingDatabase([row()]);

    await listThreads(db, { tenantId: TENANT_ID });

    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0]!;
    expect(sql).toContain('from "threads"');
    expect(sql).toContain('"threads"."tenant_id" = ');
    expect(params).toContain(TENANT_ID);
    expect(sql).toContain('order by "threads"."last_message_at" desc');
  });

  // Postgres sorts nulls first on a descending order, so a thread stored
  // before its mail would otherwise be pinned above today's mail.
  it("sends a thread with no mail date to the bottom", async () => {
    const { db, statements } = recordingDatabase();

    await listThreads(db, { tenantId: TENANT_ID });

    expect(statements[0]!.sql).toContain(
      'order by "threads"."last_message_at" desc nulls last',
    );
  });

  it("caps how many threads one page reads", async () => {
    const { db, statements } = recordingDatabase();

    await listThreads(db, { tenantId: TENANT_ID, limit: 25 });

    expect(statements[0]!.params).toContain(25);
  });

  it("turns a triaged thread into its category and status", async () => {
    const { db } = recordingDatabase([row()]);

    await expect(listThreads(db, { tenantId: TENANT_ID })).resolves.toEqual([
      {
        id: THREAD_ID,
        subject: "Pressupost",
        category: "comercial",
        lastMessageAt: new Date("2026-08-18T08:30:00Z"),
        status: "triaged",
        draftId: null,
      },
    ]);
  });

  it("reports a thread still waiting for triage", async () => {
    const { db } = recordingDatabase([
      row({ category: null, triagedAt: null }),
    ]);

    const [thread] = await listThreads(db, { tenantId: TENANT_ID });

    expect(thread).toMatchObject({
      category: null,
      status: "awaiting-triage",
    });
  });

  // The status column is the reviewer's queue, so it has to follow the draft.
  it("reports the state of the draft hanging off the thread", async () => {
    const { db } = recordingDatabase([
      row({ draftStatus: "pending", draftId: DRAFT_ID }),
    ]);

    const [thread] = await listThreads(db, { tenantId: TENANT_ID });

    expect(thread!.status).toBe("draft-pending");
    expect(thread!.draftId).toBe(DRAFT_ID);
  });

  // Regenerating supersedes the previous draft (context.md §2); reading the
  // superseded one would leave the thread stuck on a draft nobody can act on.
  it("ignores drafts a regeneration replaced", async () => {
    const { db, statements } = recordingDatabase([row()]);

    await listThreads(db, { tenantId: TENANT_ID });

    expect(statements[0]!.sql).toContain('"drafts"');
    expect(statements[0]!.params).toContain("superseded");
  });
});
