import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { listRecentContacts } from "./recent-contacts";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

/** Drizzle's proxy driver builds the statement for real and hands it back. */
const recordingDatabase = (rows: unknown[][] = []) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    return { rows };
  });
  return { db, statements };
};

describe("listRecentContacts", () => {
  it("reads the addresses of the tenant's mail, newest seen first", async () => {
    const { db, statements } = recordingDatabase([
      ["client@example.com"],
      ["copia@example.com"],
    ]);

    const contacts = await listRecentContacts(db, {
      tenantId: TENANT_ID,
      query: "exa",
    });

    expect(contacts).toEqual(["client@example.com", "copia@example.com"]);
    const { sql, params } = statements[0]!;
    // Sender, recipients and copies all count as contacts seen.
    expect(sql).toContain("unnest");
    expect(sql).toContain('"cc_addresses"');
    expect(sql).toContain("group by");
    expect(sql).toContain("desc nulls last");
    expect(params).toContain(TENANT_ID);
    expect(params).toContain("%exa%");
  });

  // The fragment comes off a form field, and `%` is a wildcard `ilike` would
  // otherwise read as "everything the tenant has ever written to".
  it("escapes the wildcards of what was typed", async () => {
    const { db, statements } = recordingDatabase();

    await listRecentContacts(db, { tenantId: TENANT_ID, query: "100%_a" });

    expect(statements[0]!.params).toContain("%100\\%\\_a%");
  });

  it("asks for no more suggestions than a list can show", async () => {
    const { db, statements } = recordingDatabase();

    await listRecentContacts(db, { tenantId: TENANT_ID, query: "a", limit: 3 });

    expect(statements[0]!.sql).toContain("limit");
    expect(statements[0]!.params).toContain(3);
  });
});
