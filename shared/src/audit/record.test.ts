import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "./events";
import { recordAuditLogEntry } from "./record";

const EVENT: AuditEvent = {
  action: "auto_reply_sent",
  tenantId: "11111111-1111-1111-1111-111111111111",
  actor: { type: "system" },
  threadId: "22222222-2222-2222-2222-222222222222",
  draftId: "33333333-3333-3333-3333-333333333333",
  category: "suport",
  sentMessageId: "55555555-5555-5555-5555-555555555555",
};

/**
 * Drizzle's proxy driver gives a real database object whose queries land in a
 * callback instead of Postgres — the insert is exercised as written, without a
 * live Neon connection in the test suite.
 */
const createRecordingDb = () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  });
  return { db, queries };
};

describe("recordAuditLogEntry", () => {
  it("inserts the entry into audit_log_entries", async () => {
    const { db, queries } = createRecordingDb();

    await recordAuditLogEntry(db, EVENT);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('insert into "audit_log_entries"');
    expect(queries[0]!.params).toEqual([
      EVENT.tenantId,
      "system",
      null,
      "auto_reply_sent",
      EVENT.threadId,
      "33333333-3333-3333-3333-333333333333",
      // jsonb reaches the driver already serialized.
      JSON.stringify({
        before: { status: "pending" },
        after: { status: "sent" },
        category: "suport",
        sentMessageId: EVENT.sentMessageId,
      }),
    ]);
  });
});
