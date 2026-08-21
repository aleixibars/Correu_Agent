import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { applyAutoDiscardRule } from "./apply";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const DRAFT_ID = "33333333-3333-3333-3333-333333333333";

const NOW = new Date("2026-06-01T09:00:00.000Z");

/** In the column order `findEnabledAutoDiscardRule` selects. */
const ruleRow = (
  enabled: boolean,
  senderPatterns: string[] = [],
  keywordPatterns: string[] = [],
  category = "newsletter",
) => [category, enabled, senderPatterns, keywordPatterns];

const createDb = ({
  rule = null as unknown[] | null,
  draftInsert = [[DRAFT_ID]] as unknown[][],
}: { rule?: unknown[] | null; draftInsert?: unknown[][] } = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "auto_discard_rules"')) {
      return { rows: rule ? [rule] : [] };
    }
    if (sql.includes('insert into "drafts"')) return { rows: draftInsert };
    return { rows: [] };
  });
  return { db, queries };
};

const shape = (sql: string): string => {
  if (sql.includes('from "auto_discard_rules"')) return "rule lookup";
  if (sql.includes('insert into "drafts"')) return "discarded draft";
  if (sql.includes('insert into "audit_log_entries"')) return "audit";
  return "other";
};

describe("applyAutoDiscardRule", () => {
  it("discards the thread when the category's default rule applies (newsletter, no row stored)", async () => {
    const { db, queries } = createDb({ rule: null });

    const discarded = await applyAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      category: "newsletter",
      fromAddresses: ["butlleti@example.com"],
      subject: "El nostre butlletí",
      now: NOW,
    });

    expect(discarded).toBe(true);
    expect(queries.map(({ sql }) => shape(sql))).toEqual([
      "rule lookup",
      "discarded draft",
      "audit",
    ]);

    const draftInsert = queries[1]!;
    expect(draftInsert.params).toContain("discarded");
    expect(draftInsert.params).toContain(THREAD_ID);
    expect(draftInsert.params).toContain(TENANT_ID);

    const audit = queries[2]!;
    expect(audit.params).toContain("thread_auto_discarded");
    expect(audit.params).toContain(THREAD_ID);
    expect(audit.params).toContain(DRAFT_ID);
  });

  it("does nothing when no rule is enabled for the category", async () => {
    const { db, queries } = createDb({ rule: null });

    const discarded = await applyAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      category: "comercial",
      fromAddresses: ["client@acme.com"],
      subject: "Pressupost",
      now: NOW,
    });

    expect(discarded).toBe(false);
    expect(queries.map(({ sql }) => shape(sql))).toEqual(["rule lookup"]);
  });

  it("does nothing when the rule is enabled but its senders/keywords do not match", async () => {
    const { db, queries } = createDb({
      rule: ruleRow(true, ["@newsletter.example.com"], [], "comercial"),
    });

    const discarded = await applyAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      category: "comercial",
      fromAddresses: ["client@acme.com"],
      subject: "Pressupost",
      now: NOW,
    });

    expect(discarded).toBe(false);
    expect(queries.map(({ sql }) => shape(sql))).toEqual(["rule lookup"]);
  });

  it("never touches urgent, whatever a planted row says", async () => {
    const { db, queries } = createDb({
      rule: ruleRow(true, [], [], "urgent"),
    });

    const discarded = await applyAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      category: "urgent",
      fromAddresses: ["client@acme.com"],
      subject: "Servidor caigut",
      now: NOW,
    });

    expect(discarded).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it("discards a matching sender even outside the default-enabled category", async () => {
    const { db } = createDb({
      rule: ruleRow(true, ["@spam.example.com"], [], "personal"),
    });

    const discarded = await applyAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      category: "personal",
      fromAddresses: ["ads@spam.example.com"],
      subject: null,
      now: NOW,
    });

    expect(discarded).toBe(true);
  });
});
