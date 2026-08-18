import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { TRIAGE_CATEGORIES, isAutoReplyEligible } from "../triage/taxonomy";
import {
  AutoReplyCategoryError,
  findEnabledAutoReplyRule,
  listAutoReplyRules,
  setAutoReplyRule,
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

const ruleRow = (
  enabled: boolean,
  instructions: string | null = null,
  category = "comercial",
) => [category, enabled, instructions];

describe("setAutoReplyRule", () => {
  it("stores the switch of an eligible category", async () => {
    const { db, queries } = createDb([
      [],
      [ruleRow(true, "Respon en to proper.")],
      [],
    ]);

    const rule = await setAutoReplyRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      instructions: "Respon en to proper.",
      actor: ACTOR,
      now: NOW,
    });

    expect(rule).toEqual({
      category: "comercial",
      enabled: true,
      instructions: "Respon en to proper.",
    });

    const write = queries[1]!;
    expect(write.sql).toContain('insert into "auto_reply_rules"');
    // One row per tenant and category, so pressing the switch again updates it
    // rather than stacking a second rule on the same category.
    expect(write.sql).toContain("on conflict");
    expect(write.params).toContain(TENANT_ID);
    expect(write.params).toContain("comercial");
  });

  it.each(["urgent", "personal", "newsletter"] as const)(
    "refuses to touch the %s rule at all (context.md §2, §4)",
    async (category) => {
      const { db, queries } = createDb();

      await expect(
        setAutoReplyRule(db, {
          tenantId: TENANT_ID,
          category,
          enabled: true,
          actor: ACTOR,
        }),
      ).rejects.toBeInstanceOf(AutoReplyCategoryError);

      // Rejected before any statement runs: an ineligible category must not
      // even get a disabled row it could later be flipped on from.
      expect(queries).toHaveLength(0);

      await expect(
        setAutoReplyRule(db, {
          tenantId: TENANT_ID,
          category,
          enabled: false,
          actor: ACTOR,
        }),
      ).rejects.toBeInstanceOf(AutoReplyCategoryError);
      expect(queries).toHaveLength(0);
    },
  );

  it("records who moved the switch and from what (context.md §7)", async () => {
    const { db, queries } = createDb([[ruleRow(false)], [ruleRow(true)], []]);

    await setAutoReplyRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      actor: ACTOR,
      now: NOW,
    });

    const audit = queries[2]!;
    expect(audit.sql).toContain('insert into "audit_log_entries"');
    expect(audit.params).toContain("auto_reply_rule_changed");
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

  it("writes no audit entry when the switch was already where it is put", async () => {
    const { db, queries } = createDb([
      [ruleRow(true, "Respon en to proper.")],
      [ruleRow(true, "Respon en to proper.")],
    ]);

    await setAutoReplyRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      instructions: "Respon en to proper.",
      actor: ACTOR,
      now: NOW,
    });

    expect(queries.some(({ sql }) => sql.includes('"audit_log_entries"'))).toBe(
      false,
    );
  });

  it("records a rewrite of the guidance with the switch left on", async () => {
    const { db, queries } = createDb([
      [ruleRow(true, "Respon en to proper.")],
      [ruleRow(true, "Ofereix sempre un descompte.")],
      [],
    ]);

    await setAutoReplyRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      instructions: "Ofereix sempre un descompte.",
      actor: ACTOR,
      now: NOW,
    });

    // The switch never moved, so the guidance is the whole change — and it
    // decides what the next unapproved mail says (context.md §7).
    const audit = queries[2]!;
    expect(audit.sql).toContain('insert into "audit_log_entries"');
    const metadata = audit.params.find(
      (param) => typeof param === "string" && param.includes('"comercial"'),
    ) as string;
    expect(JSON.parse(metadata)).toMatchObject({
      before: { enabled: true, instructions: "Respon en to proper." },
      after: { enabled: true, instructions: "Ofereix sempre un descompte." },
    });
  });

  it("stores blank guidance as none at all", async () => {
    const { db, queries } = createDb([[], [ruleRow(true)], []]);

    const rule = await setAutoReplyRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      // What an emptied textarea sends: it is not guidance, and storing it as
      // one would put a blank line in the prompt and churn the audit trail.
      instructions: "   ",
      actor: ACTOR,
      now: NOW,
    });

    expect(rule.instructions).toBeNull();
    expect(queries[1]!.params).not.toContain("   ");
    expect(queries[1]!.params).toContain(null);
  });

  it("trims the guidance it stores", async () => {
    const { db, queries } = createDb([
      [],
      [ruleRow(true, "Respon en to proper.")],
      [],
    ]);

    await setAutoReplyRule(db, {
      tenantId: TENANT_ID,
      category: "comercial",
      enabled: true,
      instructions: "  Respon en to proper.\n",
      actor: ACTOR,
      now: NOW,
    });

    expect(queries[1]!.params).toContain("Respon en to proper.");
  });

  it("treats a category with no rule yet as switched off", async () => {
    const { db, queries } = createDb([[], [ruleRow(false)]]);

    await setAutoReplyRule(db, {
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
});

describe("listAutoReplyRules", () => {
  it("reports every eligible category, defaulting the unconfigured ones to off", async () => {
    const { db, queries } = createDb([
      [ruleRow(true, "Respon en to proper.", "comercial")],
    ]);

    const rules = await listAutoReplyRules(db, TENANT_ID);

    expect(rules).toEqual([
      {
        category: "comercial",
        enabled: true,
        instructions: "Respon en to proper.",
      },
      { category: "suport", enabled: false, instructions: null },
      { category: "facturacio", enabled: false, instructions: null },
    ]);
    // The categories that can never be switched on are not offered at all
    // (context.md §2) — the dashboard renders exactly what this returns.
    for (const category of ["urgent", "newsletter", "personal"]) {
      expect(rules.map((rule) => rule.category)).not.toContain(category);
    }
    expect(queries[0]!.params).toContain(TENANT_ID);
  });
});

describe("findEnabledAutoReplyRule", () => {
  it("returns the rule when the category's switch is on", async () => {
    const { db } = createDb([[ruleRow(true, "Respon en to proper.")]]);

    expect(
      await findEnabledAutoReplyRule(db, {
        tenantId: TENANT_ID,
        category: "comercial",
      }),
    ).toEqual({
      category: "comercial",
      enabled: true,
      instructions: "Respon en to proper.",
    });
  });

  it("answers null for an ineligible category without asking the database", async () => {
    const { db, queries } = createDb([[ruleRow(true, null, "urgent")]]);

    for (const category of TRIAGE_CATEGORIES.filter(
      (category) => !isAutoReplyEligible(category),
    )) {
      expect(
        await findEnabledAutoReplyRule(db, { tenantId: TENANT_ID, category }),
      ).toBeNull();
    }

    // Not even a row planted in the table can turn one of these on.
    expect(queries).toHaveLength(0);
  });

  it("answers null when the rule exists but is switched off", async () => {
    const { db, queries } = createDb([[]]);

    expect(
      await findEnabledAutoReplyRule(db, {
        tenantId: TENANT_ID,
        category: "suport",
      }),
    ).toBeNull();

    // The switch is part of the query, not something the caller has to check:
    // a disabled rule must never come back as one that can send.
    expect(queries[0]!.sql.split(" where ")[1]).toContain('"enabled"');
    expect(queries[0]!.params).toContain(true);
  });
});
