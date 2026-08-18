import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import { generateDailyDigest } from "./generate";
import { DIGEST_MODEL, type DigestMessagesClient } from "./summarise";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

const DAY = "2026-06-01";
const NOW = new Date("2026-06-02T05:00:00.000Z");

/** In the column order the digest select asks for: id, subject, category, lastMessageAt. */
const threadRow = (id: string, category: string) => [
  id,
  "Assumpte",
  category,
  `${DAY}T09:00:00.000Z`,
];

const createClient = (text = "Resum del dia.") => {
  const create = vi.fn(
    async () =>
      ({
        model: DIGEST_MODEL,
        content: [{ type: "text", text }],
      }) as unknown as Anthropic.Message,
  );
  return { client: { create } as unknown as DigestMessagesClient, create };
};

const createDb = (threads: unknown[][]) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "threads"')) return { rows: threads };
    return { rows: [] };
  });
  return { db, queries };
};

describe("generateDailyDigest", () => {
  it("stores the day's digest and reports what it wrote", async () => {
    const { db, queries } = createDb([
      threadRow("t1", "urgent"),
      threadRow("t2", "comercial"),
    ]);
    const { client, create } = createClient("Dos fils, un d'urgent.");

    const digest = await generateDailyDigest(db, client, {
      tenantId: TENANT_ID,
      day: DAY,
      now: NOW,
    });

    expect(digest).toEqual({
      tenantId: TENANT_ID,
      day: DAY,
      threadCount: 2,
      summary: "Dos fils, un d'urgent.",
      model: DIGEST_MODEL,
    });
    expect(create).toHaveBeenCalledOnce();

    const insert = queries.at(-1)!;
    expect(insert.sql).toContain('insert into "daily_digests"');
    expect(insert.params).toContain(TENANT_ID);
    expect(insert.params).toContain(DAY);
    expect(insert.params).toContain("Dos fils, un d'urgent.");
  });

  it("overwrites the digest of a day it already covered", async () => {
    const { db, queries } = createDb([threadRow("t1", "suport")]);
    const { client } = createClient();

    await generateDailyDigest(db, client, {
      tenantId: TENANT_ID,
      day: DAY,
      now: NOW,
    });

    // A re-run replaces the day rather than stacking a second summary of the
    // same mail behind the first.
    const insert = queries.at(-1)!;
    expect(insert.sql).toContain("on conflict");
    expect(insert.sql).toContain("do update set");
  });

  it("skips a day with no processed mail, without paying for a model call", async () => {
    const { db, queries } = createDb([]);
    const { client, create } = createClient();

    const digest = await generateDailyDigest(db, client, {
      tenantId: TENANT_ID,
      day: DAY,
      now: NOW,
    });

    expect(digest).toBeNull();
    expect(create).not.toHaveBeenCalled();
    // Nothing written either: an empty digest row would only be a heading over
    // nothing in the dashboard.
    expect(queries.every(({ sql }) => !sql.includes("insert into"))).toBe(true);
  });
});
