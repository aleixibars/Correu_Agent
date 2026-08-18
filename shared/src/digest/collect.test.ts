import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { TRIAGE_CATEGORIES } from "../triage/taxonomy";
import {
  collectDailyDigest,
  digestDay,
  digestDayRange,
  previousDigestDay,
} from "./collect";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

const DAY = "2026-06-01";

/** In the column order the digest select asks for. */
const threadRow = (
  id: string,
  category: string,
  subject: string | null = "Assumpte",
  lastMessageAt: string | null = `${DAY}T09:00:00.000Z`,
) => [id, subject, category, lastMessageAt];

const createDb = (rows: unknown[][]) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows };
  });
  return { db, queries };
};

describe("digestDay", () => {
  it("names the UTC calendar day a moment falls in", () => {
    expect(digestDay(new Date("2026-06-01T23:30:00.000Z"))).toBe("2026-06-01");
  });

  it("names the day before as the last full day a digest can cover", () => {
    expect(previousDigestDay(new Date("2026-06-01T05:00:00.000Z"))).toBe(
      "2026-05-31",
    );
  });
});

describe("digestDayRange", () => {
  it("spans one UTC day, closed at the start and open at the end", () => {
    expect(digestDayRange(DAY)).toEqual({
      start: new Date("2026-06-01T00:00:00.000Z"),
      end: new Date("2026-06-02T00:00:00.000Z"),
    });
  });

  it("rejects anything that is not a calendar date", () => {
    expect(() => digestDayRange("01/06/2026")).toThrow();
    expect(() => digestDayRange("2026-02-31")).toThrow();
  });

  it("accepts a leap day, which the round-trip check must not mistake for one", () => {
    // 29 February exists in 2028 and rolls forward in 2027: the check has to
    // tell those apart rather than refuse every February day it distrusts.
    expect(digestDayRange("2028-02-29").end).toEqual(
      new Date("2028-03-01T00:00:00.000Z"),
    );
    expect(() => digestDayRange("2027-02-29")).toThrow();
  });

  it("names the day it rejected, even one Date cannot parse at all", () => {
    // "2026-13-01" is not a date `Date` rolls forward, it is one it refuses:
    // the day has to be named in the error rather than surface as an
    // "Invalid time value" from deep inside the range check.
    expect(() => digestDayRange("2026-13-01")).toThrow(/"2026-13-01"/);
  });
});

describe("collectDailyDigest", () => {
  it("reads only the threads triaged on that day, for that tenant", async () => {
    const { db, queries } = createDb([]);

    await collectDailyDigest(db, { tenantId: TENANT_ID, day: DAY });

    const { sql, params } = queries[0]!;
    expect(sql).toContain('from "threads"');
    expect(params).toContain(TENANT_ID);
    // The day the mail was *processed* is what the digest reports (context.md §2).
    expect(sql).toContain('"triaged_at"');
    expect(params).toContain("2026-06-01T00:00:00.000Z");
    expect(params).toContain("2026-06-02T00:00:00.000Z");
  });

  it("groups the day's threads by category, in taxonomy order", async () => {
    const { db } = createDb([
      threadRow("thread-personal", "personal"),
      threadRow("thread-urgent", "urgent"),
      threadRow("thread-comercial-1", "comercial"),
      threadRow("thread-comercial-2", "comercial"),
    ]);

    const digest = await collectDailyDigest(db, {
      tenantId: TENANT_ID,
      day: DAY,
    });

    expect(digest.day).toBe(DAY);
    expect(digest.threadCount).toBe(4);
    // Taxonomy order, not the order the rows arrived in: the dashboard shows
    // urgent first and the catch-all last (context.md §4).
    expect(digest.sections.map((section) => section.category)).toEqual([
      "urgent",
      "comercial",
      "personal",
    ]);
    expect(
      digest.sections.map((section) => section.threads.map(({ id }) => id)),
    ).toEqual([
      ["thread-urgent"],
      ["thread-comercial-1", "thread-comercial-2"],
      ["thread-personal"],
    ]);
  });

  it("leaves out a category nothing landed in", async () => {
    const { db } = createDb([threadRow("thread-1", "suport")]);

    const digest = await collectDailyDigest(db, {
      tenantId: TENANT_ID,
      day: DAY,
    });

    expect(digest.sections).toHaveLength(1);
    expect(TRIAGE_CATEGORIES).toHaveLength(6);
  });

  it("reports an empty day rather than failing on it", async () => {
    const { db } = createDb([]);

    await expect(
      collectDailyDigest(db, { tenantId: TENANT_ID, day: DAY }),
    ).resolves.toEqual({ day: DAY, threadCount: 0, sections: [] });
  });

  it("reads no mail body, so a purged day still digests the same", async () => {
    // The body is gone after 90 days (context.md §7); a digest built from the
    // thread's subject and category alone reads the same before and after.
    const { db, queries } = createDb([
      threadRow("thread-1", "facturacio", "Factura 42", null),
    ]);

    const digest = await collectDailyDigest(db, {
      tenantId: TENANT_ID,
      day: DAY,
    });

    expect(digest.sections[0]!.threads[0]).toEqual({
      id: "thread-1",
      subject: "Factura 42",
      category: "facturacio",
      lastMessageAt: null,
    });
    expect(queries[0]!.sql).not.toContain('"body_text"');
    expect(queries[0]!.sql).not.toContain('"body_html"');
  });
});
