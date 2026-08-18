import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import {
  RETENTION_DAYS,
  purgeExpiredMessageBodies,
  retentionCutoff,
} from "./purge";

const MESSAGE_ID = "55555555-5555-5555-5555-555555555555";

const NOW = new Date("2026-06-01T03:00:00.000Z");

/**
 * Drizzle's proxy driver builds the statement for real and hands it back
 * instead of reaching Neon, so the test asserts on what would be written.
 */
const createDb = (rows: unknown[][] = [[MESSAGE_ID]]) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows };
  });
  return { db, queries };
};

describe("retentionCutoff", () => {
  it("is 90 days before the given moment (context.md §7)", () => {
    expect(RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(NOW)).toEqual(new Date("2026-03-03T03:00:00.000Z"));
  });
});

describe("purgeExpiredMessageBodies", () => {
  it("drops the body of mail older than the retention window", async () => {
    const { db, queries } = createDb();

    const purged = await purgeExpiredMessageBodies(db, { now: NOW });

    expect(purged).toBe(1);

    const { sql, params } = queries[0]!;
    expect(sql).toContain('update "messages" set');
    const set = sql.slice(sql.indexOf("set "), sql.indexOf(" where "));
    expect(set).toContain('"body_text" = $');
    expect(set).toContain('"body_html" = $');
    expect(set).toContain('"body_purged_at" = $');
    // The row survives the purge, only its body goes (context.md §7).
    expect(sql).not.toContain('delete from "messages"');
    expect(params).toContain(retentionCutoff(NOW).toISOString());
  });

  it("keeps the schematic version of a purged message consultable", async () => {
    const { db, queries } = createDb();

    await purgeExpiredMessageBodies(db, { now: NOW });

    const { sql } = queries[0]!;
    const set = sql.slice(sql.indexOf("set "), sql.indexOf(" where "));
    // Metadata and the summary are what is left behind, so the purge must not
    // touch them — beyond filling in a snippet for mail that never had one,
    // which is the only summary a purged message keeps.
    for (const column of [
      '"subject"',
      '"from_address"',
      '"to_addresses"',
      '"sent_at"',
      '"direction"',
      '"message_id_header"',
    ]) {
      expect(set).not.toContain(column);
    }
    expect(set).toContain('coalesce("messages"."snippet"');
    expect(set).toContain('"messages"."body_text"');
    // HTML-only mail (every Graph message with an HTML body) has no body_text,
    // so its markup is stripped rather than leaving it with no summary at all.
    expect(set).toContain('"messages"."body_html"');
    expect(set).toContain("regexp_replace");

    // The category lives on the thread, which the purge never writes to.
    expect(sql).not.toContain('"threads"');
  });

  it("never purges the same message twice", async () => {
    const { db, queries } = createDb();

    await purgeExpiredMessageBodies(db, { now: NOW });

    const { sql } = queries[0]!;
    const where = sql.slice(sql.indexOf(" where "), sql.indexOf(" returning"));
    expect(where).toContain('"body_purged_at" is null');
    // Mail the provider dated for us is aged by its own date; a row without one
    // falls back to when it was stored, so it cannot outlive the window either.
    expect(where).toContain('coalesce("messages"."sent_at", "messages"."created_at")');
  });

  it("reports nothing when no mail has expired", async () => {
    const { db } = createDb([]);

    await expect(purgeExpiredMessageBodies(db, { now: NOW })).resolves.toBe(0);
  });
});
