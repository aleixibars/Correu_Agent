import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { latestDailyDigest } from "./latest-digest";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

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

/** In the column order the digest select asks for. */
const digestRow = (day = "2026-08-17"): unknown[] => [
  day,
  "Dia tranquil: dos fils comercials.",
  "2026-08-18 06:00:00+00",
];

describe("latestDailyDigest", () => {
  it("reads the newest digest of the tenant alone", async () => {
    const { db, statements } = recordingDatabase([digestRow()]);

    await latestDailyDigest(db, { tenantId: TENANT_ID });

    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0]!;
    expect(sql).toContain('from "daily_digests"');
    expect(sql).toContain('"daily_digests"."tenant_id" = ');
    expect(params).toContain(TENANT_ID);
    expect(sql).toContain('order by "daily_digests"."digest_date" desc');
    expect(sql).toContain("limit");
  });

  it("answers with the stored digest of that day", async () => {
    const { db } = recordingDatabase([digestRow("2026-08-17")]);

    expect(await latestDailyDigest(db, { tenantId: TENANT_ID })).toEqual({
      day: "2026-08-17",
      summary: "Dia tranquil: dos fils comercials.",
      updatedAt: new Date("2026-08-18T06:00:00.000Z"),
    });
  });

  // A tenant whose first digest has not run yet, which the page renders as an
  // empty state rather than as a heading over nothing.
  it("answers with null when no digest has been written yet", async () => {
    const { db } = recordingDatabase([]);

    expect(await latestDailyDigest(db, { tenantId: TENANT_ID })).toBeNull();
  });
});
