import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { decryptToken } from "../token-encryption";
import { connectMailboxAccount } from "./connect";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const MAILBOX_ID = "33333333-3333-3333-3333-333333333333";

const ENCRYPTION_KEY = randomBytes(32);

const INPUT = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  provider: "microsoft" as const,
  emailAddress: "bustia@example.com",
  providerAccountId: "graph-user-id",
  tokens: {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date("2026-01-01T01:00:00.000Z"),
  },
  encryptionKey: ENCRYPTION_KEY,
};

/** Drizzle's proxy driver runs the query as written, without a live Neon connection. */
const createRecordingDb = () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [[MAILBOX_ID]] };
  });
  return { db, queries };
};

describe("connectMailboxAccount", () => {
  it("stores the tokens encrypted, never in clear", async () => {
    const { db, queries } = createRecordingDb();

    const id = await connectMailboxAccount(db, INPUT);

    expect(id).toBe(MAILBOX_ID);
    expect(queries).toHaveLength(1);

    const params = queries[0]!.params as string[];
    expect(params).not.toContain("access-token");
    expect(params).not.toContain("refresh-token");

    // Both tokens travel twice: once in the insert, once in the do-update set.
    const envelopes = params.filter(
      (param) => typeof param === "string" && param.startsWith("v1:"),
    );
    expect(
      new Set(envelopes.map((envelope) => decryptToken(envelope, ENCRYPTION_KEY))),
    ).toEqual(new Set(["access-token", "refresh-token"]));
  });

  it("re-connecting the same mailbox refreshes its credentials in place", async () => {
    const { db, queries } = createRecordingDb();

    await connectMailboxAccount(db, INPUT);

    const { sql } = queries[0]!;
    expect(sql).toContain('insert into "mailbox_accounts"');
    expect(sql).toContain(
      'on conflict ("tenant_id","provider","email_address") do update set',
    );
    // Re-consenting must not move the "only mail newer than this" line
    // (context.md §4) nor drop where the next poll resumes from.
    expect(sql).not.toMatch(/do update set[\s\S]*"connected_at"/);
    expect(sql).not.toMatch(/do update set[\s\S]*"sync_cursor"/);
  });
});
