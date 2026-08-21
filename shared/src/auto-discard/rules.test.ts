import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { TRIAGE_CATEGORIES, isAutoDiscardEligible } from "../triage/taxonomy";
import {
  AutoDiscardCategoryError,
  findEnabledAutoDiscardRule,
  listAutoDiscardRules,
  setAutoDiscardRule,
} from "./rules";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

const ACTOR = { type: "user", userId: USER_ID } as const;

const NOW = new Date("2026-06-01T09:00:00.000Z");

/** Drizzle's proxy driver builds the statement for real and hands it back instead of reaching Neon. */
const createDb = (results: unknown[][][] = []) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: results[queries.length - 1] ?? [] };
  });
  return { db, queries };
};

const ruleRow = (enabled: boolean, category = "comercial") => [category, enabled];

describe("setAutoDiscardRule", () => {
  it("stores the switch of an eligible category", async () => {
    const { db, queries } = createDb([[], [ruleRow(true)], []]);

    const rule = await setAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      actor: ACTOR,
      now: NOW,
    });

    expect(rule).toEqual({ category: "comercial", enabled: true });

    const write = queries[1]!;
    expect(write.sql).toContain('insert into "auto_discard_rules"');
    expect(write.sql).toContain("on conflict");
    expect(write.params).toContain(TENANT_ID);
    expect(write.params).toContain("comercial");
  });

  it("refuses to touch the urgent rule at all (context.md §4)", async () => {
    const { db, queries } = createDb();

    await expect(
      setAutoDiscardRule(db, {
        tenantId: TENANT_ID,
        category: "urgent",
        enabled: true,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(AutoDiscardCategoryError);
    // Rejected before any statement runs: an ineligible category must not even
    // get a disabled row it could later be flipped on from.
    expect(queries).toHaveLength(0);

    await expect(
      setAutoDiscardRule(db, {
        tenantId: TENANT_ID,
        category: "urgent",
        enabled: false,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(AutoDiscardCategoryError);
    expect(queries).toHaveLength(0);
  });

  it("records who moved the switch and from what (context.md §7)", async () => {
    const { db, queries } = createDb([[ruleRow(false)], [ruleRow(true)], []]);

    await setAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      actor: ACTOR,
      now: NOW,
    });

    const audit = queries[2]!;
    expect(audit.sql).toContain('insert into "audit_log_entries"');
    expect(audit.params).toContain("auto_discard_rule_changed");
    expect(audit.params).toContain(USER_ID);
    const metadata = audit.params.find(
      (param) => typeof param === "string" && param.includes('"comercial"'),
    ) as string;
    expect(JSON.parse(metadata)).toMatchObject({
      before: { enabled: false },
      after: { enabled: true },
      category: "comercial",
    });
  });

  it("writes no audit entry when the switch is already what is put", async () => {
    const { db, queries } = createDb([[ruleRow(true)], [ruleRow(true)]]);

    await setAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      actor: ACTOR,
      now: NOW,
    });

    expect(queries.some(({ sql }) => sql.includes('"audit_log_entries"'))).toBe(
      false,
    );
  });

  it("treats a category with no rule yet as switched off, except newsletter", async () => {
    const { db, queries } = createDb([[], [ruleRow(false)]]);

    await setAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      category: "suport",
      enabled: false,
      actor: ACTOR,
      now: NOW,
    });

    // Nothing changed: a missing rule and a disabled one are the same state.
    expect(queries.some(({ sql }) => sql.includes('"audit_log_entries"'))).toBe(
      false,
    );
  });

  it("audits switching newsletter off, since its unconfigured default is on", async () => {
    const { db, queries } = createDb([[], [ruleRow(false, "newsletter")], []]);

    await setAutoDiscardRule(db, {
      tenantId: TENANT_ID,
      category: "newsletter",
      enabled: false,
      actor: ACTOR,
      now: NOW,
    });

    const audit = queries[2]!;
    expect(audit.sql).toContain('insert into "audit_log_entries"');
    const metadata = audit.params.find(
      (param) => typeof param === "string" && param.includes('"newsletter"'),
    ) as string;
    expect(JSON.parse(metadata)).toMatchObject({
      before: { enabled: true },
      after: { enabled: false },
    });
  });
});

describe("listAutoDiscardRules", () => {
  it("reports every eligible category, defaulting newsletter on and the rest off", async () => {
    const { db, queries } = createDb([[ruleRow(true, "comercial")]]);

    const rules = await listAutoDiscardRules(db, TENANT_ID);

    expect(rules).toEqual([
      { category: "comercial", enabled: true },
      { category: "suport", enabled: false },
      { category: "facturacio", enabled: false },
      { category: "newsletter", enabled: true },
      { category: "personal", enabled: false },
    ]);
    // Urgent can never be switched on, so it is not offered at all.
    expect(rules.map((rule) => rule.category)).not.toContain("urgent");
    expect(queries[0]!.params).toContain(TENANT_ID);
  });

  it("respects a stored row that switches newsletter off", async () => {
    const { db } = createDb([[ruleRow(false, "newsletter")]]);

    const rules = await listAutoDiscardRules(db, TENANT_ID);

    expect(rules.find((rule) => rule.category === "newsletter")).toEqual({
      category: "newsletter",
      enabled: false,
    });
  });
});

describe("findEnabledAutoDiscardRule", () => {
  it("returns the rule when the category's switch is on", async () => {
    const { db } = createDb([[ruleRow(true)]]);

    expect(
      await findEnabledAutoDiscardRule(db, {
        tenantId: TENANT_ID,
        category: "comercial",
      }),
    ).toEqual({ category: "comercial", enabled: true });
  });

  it("answers null for urgent without asking the database", async () => {
    const { db, queries } = createDb([[ruleRow(true, "urgent")]]);

    expect(
      await findEnabledAutoDiscardRule(db, {
        tenantId: TENANT_ID,
        category: "urgent",
      }),
    ).toBeNull();
    // Not even a row planted in the table can turn this one on.
    expect(queries).toHaveLength(0);
  });

  it("answers null when the rule exists but is switched off", async () => {
    const { db } = createDb([[ruleRow(false, "suport")]]);

    expect(
      await findEnabledAutoDiscardRule(db, {
        tenantId: TENANT_ID,
        category: "suport",
      }),
    ).toBeNull();
  });

  it("defaults newsletter to enabled when no row is stored at all", async () => {
    const { db } = createDb([[]]);

    expect(
      await findEnabledAutoDiscardRule(db, {
        tenantId: TENANT_ID,
        category: "newsletter",
      }),
    ).toEqual({ category: "newsletter", enabled: true });
  });

  it("defaults every other category to off when no row is stored", async () => {
    const { db } = createDb([[]]);

    for (const category of TRIAGE_CATEGORIES.filter(
      (category) => isAutoDiscardEligible(category) && category !== "newsletter",
    )) {
      expect(
        await findEnabledAutoDiscardRule(db, { tenantId: TENANT_ID, category }),
      ).toBeNull();
    }
  });
});
