// Granular auto-reply switches (context.md §2): auto-reply is opt-in per
// category and per tenant, never a global all-or-nothing toggle. Only
// Comercial/Vendes, Suport and Facturació can ever be switched on — Urgent and
// Personal/Altres are too risky, and newsletters are archived rather than
// answered (context.md §4).

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry, type UserActor } from "../audit";
import { autoReplyRules } from "../db/schema";
import {
  AUTO_REPLY_ELIGIBLE_CATEGORIES,
  isAutoReplyEligible,
  type TriageCategory,
} from "../triage/taxonomy";

/** One category's switch, as the dashboard shows it and the sender reads it. */
export interface AutoReplyRule {
  category: TriageCategory;
  enabled: boolean;
  /** Extra guidance for replies this rule fires; null when the tenant gave none. */
  instructions: string | null;
}

/**
 * Thrown when a rule is written for a category auto-reply can never apply to.
 * The database refuses to store an *enabled* ineligible rule too
 * (`auto_reply_rules_eligible_category`); this refuses the whole write, so a
 * disabled row nobody meant to configure never exists to be flipped on later.
 */
export class AutoReplyCategoryError extends Error {
  constructor(readonly category: TriageCategory) {
    super(
      `Auto-reply is not available for the "${category}" category (context.md §2).`,
    );
    this.name = "AutoReplyCategoryError";
  }
}

const ruleColumns = {
  category: autoReplyRules.category,
  enabled: autoReplyRules.enabled,
  instructions: autoReplyRules.instructions,
};

export interface SetAutoReplyRuleInput {
  tenantId: string;
  category: TriageCategory;
  enabled: boolean;
  /** Replaces whatever guidance the rule carried; omit to clear it. */
  instructions?: string | null;
  /** Who moved the switch — the audit trail's accountability anchor. */
  actor: UserActor;
  /** Stamp for the write; defaults to the wall clock. */
  now?: Date;
}

/**
 * Turns one category's auto-reply on or off and answers the stored rule.
 *
 * Rejects an ineligible category outright (`AutoReplyCategoryError`), and
 * records the move in the audit log: a mail that later leaves the mailbox with
 * nobody approving it is only explainable if the switch that allowed it is in
 * the trail too (context.md §7). A write that changes nothing records nothing.
 */
export const setAutoReplyRule = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  {
    tenantId,
    category,
    enabled,
    instructions = null,
    actor,
    now = new Date(),
  }: SetAutoReplyRuleInput,
): Promise<AutoReplyRule> => {
  if (!isAutoReplyEligible(category)) throw new AutoReplyCategoryError(category);

  const [previous] = await db
    .select(ruleColumns)
    .from(autoReplyRules)
    .where(
      and(
        eq(autoReplyRules.tenantId, tenantId),
        eq(autoReplyRules.category, category),
      ),
    )
    .limit(1);

  const [stored] = await db
    .insert(autoReplyRules)
    .values({ tenantId, category, enabled, instructions, updatedAt: now })
    .onConflictDoUpdate({
      target: [autoReplyRules.tenantId, autoReplyRules.category],
      // `$onUpdate` does not fire on a conflict path, so the stamp is explicit.
      set: { enabled, instructions, updatedAt: now },
    })
    .returning(ruleColumns);

  if (!stored) {
    throw new Error(`Failed to store the ${category} auto-reply rule.`);
  }

  // A category with no rule yet is off: pressing "off" on one is not a change.
  const previousEnabled = previous?.enabled ?? false;
  const unchanged =
    previousEnabled === stored.enabled &&
    (previous?.instructions ?? null) === stored.instructions;

  if (!unchanged) {
    await recordAuditLogEntry(db, {
      action: "auto_reply_rule_changed",
      tenantId,
      actor,
      category,
      previousEnabled,
      enabled: stored.enabled,
      instructions: stored.instructions,
      occurredAt: now,
    });
  }

  return stored;
};

/**
 * Every category auto-reply can be switched on for, in taxonomy order, with the
 * ones nobody has configured yet reported as off. Categories that can never be
 * switched on are left out entirely, so the dashboard cannot offer them.
 */
export const listAutoReplyRules = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  tenantId: string,
): Promise<AutoReplyRule[]> => {
  const stored = await db
    .select(ruleColumns)
    .from(autoReplyRules)
    .where(
      and(
        eq(autoReplyRules.tenantId, tenantId),
        inArray(autoReplyRules.category, [...AUTO_REPLY_ELIGIBLE_CATEGORIES]),
      ),
    );

  const byCategory = new Map(stored.map((rule) => [rule.category, rule]));

  return AUTO_REPLY_ELIGIBLE_CATEGORIES.map(
    (category) =>
      byCategory.get(category) ?? {
        category,
        enabled: false,
        instructions: null,
      },
  );
};

export interface AutoReplyRuleLookup {
  tenantId: string;
  category: TriageCategory;
}

/**
 * The rule that lets a thread of this category be answered without approval, or
 * null when there is none. An ineligible category answers null without reading
 * the table at all — a row planted there must not be able to turn one on.
 */
export const findEnabledAutoReplyRule = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, category }: AutoReplyRuleLookup,
): Promise<AutoReplyRule | null> => {
  if (!isAutoReplyEligible(category)) return null;

  const [rule] = await db
    .select(ruleColumns)
    .from(autoReplyRules)
    .where(
      and(
        eq(autoReplyRules.tenantId, tenantId),
        eq(autoReplyRules.category, category),
        eq(autoReplyRules.enabled, true),
      ),
    )
    .limit(1);

  return rule ?? null;
};
