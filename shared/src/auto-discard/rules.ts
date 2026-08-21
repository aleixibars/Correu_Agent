// Granular auto-discard switches, following the exact pattern of
// `auto-reply/rules.ts`: opt-in per category and per tenant, never a global
// all-or-nothing toggle. Every category except urgent is eligible — urgent must
// always reach a human (context.md §4), the same invariant
// `AUTO_REPLY_ELIGIBLE_CATEGORIES` enforces on the opposite action.
//
// Unlike auto-reply, `newsletter` is discarded automatically even with *no row
// stored at all*: butlletins already never get a reply drafted
// (`DRAFT_ELIGIBLE_CATEGORIES`), so defaulting the switch to on means a tenant
// gets the sensible behaviour for free instead of having to find this screen
// first.

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { recordAuditLogEntry, type UserActor } from "../audit";
import { autoDiscardRules } from "../db/schema";
import {
  AUTO_DISCARD_ELIGIBLE_CATEGORIES,
  isAutoDiscardEligible,
  type TriageCategory,
} from "../triage/taxonomy";

/**
 * One category's switch and its patterns, as the dashboard shows it and
 * `applyAutoDiscardRule` reads it. Named apart from the `AutoDiscardRule` row
 * type in `db/schema` because it is the fields that decide behaviour, not the
 * stored row (mirrors `AutoReplyRuleState`).
 */
export interface AutoDiscardRuleState {
  category: TriageCategory;
  enabled: boolean;
  senderPatterns: string[];
  keywordPatterns: string[];
}

/**
 * Thrown when a rule is written for a category auto-discard can never apply
 * to. The database refuses to store an *enabled* ineligible rule too
 * (`auto_discard_rules_eligible_category`); this refuses the whole write, so a
 * disabled row nobody meant to configure never exists to be flipped on later.
 */
export class AutoDiscardCategoryError extends Error {
  constructor(readonly category: TriageCategory) {
    super(
      `Auto-discard is not available for the "${category}" category (context.md §4).`,
    );
    this.name = "AutoDiscardCategoryError";
  }
}

const ruleColumns = {
  category: autoDiscardRules.category,
  enabled: autoDiscardRules.enabled,
  senderPatterns: autoDiscardRules.senderPatterns,
  keywordPatterns: autoDiscardRules.keywordPatterns,
};

/** The only category discarded automatically with no row stored at all. */
const DEFAULT_ENABLED_CATEGORY: TriageCategory = "newsletter";

/** What an unconfigured category reads as: on for newsletter, off for everything else. */
const defaultRuleState = (category: TriageCategory): AutoDiscardRuleState => ({
  category,
  enabled: category === DEFAULT_ENABLED_CATEGORY,
  senderPatterns: [],
  keywordPatterns: [],
});

const normalizePatterns = (patterns: string[]): string[] =>
  patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export interface SetAutoDiscardRuleInput {
  tenantId: string;
  category: TriageCategory;
  enabled: boolean;
  /** Replaces whatever senders the rule carried; omit or empty to clear. */
  senderPatterns?: string[];
  /** Replaces whatever keywords the rule carried; omit or empty to clear. */
  keywordPatterns?: string[];
  /** Who moved the switch — the audit trail's accountability anchor. */
  actor: UserActor;
  /** Stamp for the write; defaults to the wall clock. */
  now?: Date;
}

/**
 * Turns one category's auto-discard on or off, with its sender/keyword
 * patterns, and answers the stored rule.
 *
 * Rejects an ineligible category outright (`AutoDiscardCategoryError`), and
 * records the move in the audit log: a thread later closed out with nobody
 * looking at it is only explainable if the switch that allowed it is in the
 * trail too (context.md §7). A write that changes nothing records nothing.
 */
export const setAutoDiscardRule = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  {
    tenantId,
    category,
    enabled,
    senderPatterns = [],
    keywordPatterns = [],
    actor,
    now = new Date(),
  }: SetAutoDiscardRuleInput,
): Promise<AutoDiscardRuleState> => {
  if (!isAutoDiscardEligible(category)) throw new AutoDiscardCategoryError(category);

  const senders = normalizePatterns(senderPatterns);
  const keywords = normalizePatterns(keywordPatterns);

  const [previous] = await db
    .select(ruleColumns)
    .from(autoDiscardRules)
    .where(
      and(
        eq(autoDiscardRules.tenantId, tenantId),
        eq(autoDiscardRules.category, category),
      ),
    )
    .limit(1);

  const [stored] = await db
    .insert(autoDiscardRules)
    .values({
      tenantId,
      category,
      enabled,
      senderPatterns: senders,
      keywordPatterns: keywords,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [autoDiscardRules.tenantId, autoDiscardRules.category],
      // `$onUpdate` does not fire on a conflict path, so the stamp is explicit.
      set: {
        enabled,
        senderPatterns: senders,
        keywordPatterns: keywords,
        updatedAt: now,
      },
    })
    .returning(ruleColumns);

  if (!stored) {
    throw new Error(`Failed to store the ${category} auto-discard rule.`);
  }

  // A category with no rule yet reads as its default (on for newsletter, off
  // otherwise) — pressing that same state on one is not a change.
  const fallback = defaultRuleState(category);
  const previousEnabled = previous?.enabled ?? fallback.enabled;
  const previousSenderPatterns = previous?.senderPatterns ?? fallback.senderPatterns;
  const previousKeywordPatterns = previous?.keywordPatterns ?? fallback.keywordPatterns;

  const unchanged =
    previousEnabled === stored.enabled &&
    sameList(previousSenderPatterns, stored.senderPatterns) &&
    sameList(previousKeywordPatterns, stored.keywordPatterns);

  if (!unchanged) {
    await recordAuditLogEntry(db, {
      action: "auto_discard_rule_changed",
      tenantId,
      actor,
      category,
      previousEnabled,
      enabled: stored.enabled,
      previousSenderPatterns,
      senderPatterns: stored.senderPatterns,
      previousKeywordPatterns,
      keywordPatterns: stored.keywordPatterns,
      occurredAt: now,
    });
  }

  return stored;
};

/**
 * Every category auto-discard can be switched on for, in taxonomy order, with
 * the ones nobody has configured yet reported at their default — on for
 * newsletter, off for the rest. Categories that can never be switched on
 * (urgent) are left out entirely, so the dashboard cannot offer them.
 */
export const listAutoDiscardRules = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  tenantId: string,
): Promise<AutoDiscardRuleState[]> => {
  const stored = await db
    .select(ruleColumns)
    .from(autoDiscardRules)
    .where(
      and(
        eq(autoDiscardRules.tenantId, tenantId),
        inArray(autoDiscardRules.category, [...AUTO_DISCARD_ELIGIBLE_CATEGORIES]),
      ),
    );

  const byCategory = new Map(stored.map((rule) => [rule.category, rule]));

  return AUTO_DISCARD_ELIGIBLE_CATEGORIES.map(
    (category) => byCategory.get(category) ?? defaultRuleState(category),
  );
};

export interface AutoDiscardRuleLookup {
  tenantId: string;
  category: TriageCategory;
}

/**
 * The rule that lets a thread of this category be discarded outright, or null
 * when there is none. An ineligible category answers null without reading the
 * table at all — a row planted there must not be able to turn one on.
 *
 * Unlike `findEnabledAutoReplyRule`, the "enabled" filter is not pushed into
 * the query: a category can be enabled with *no row at all* (newsletter's
 * default), so the row has to be read regardless of its switch to tell "no row
 * yet" apart from "a row that explicitly turned it off".
 */
export const findEnabledAutoDiscardRule = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, category }: AutoDiscardRuleLookup,
): Promise<AutoDiscardRuleState | null> => {
  if (!isAutoDiscardEligible(category)) return null;

  const [rule] = await db
    .select(ruleColumns)
    .from(autoDiscardRules)
    .where(
      and(
        eq(autoDiscardRules.tenantId, tenantId),
        eq(autoDiscardRules.category, category),
      ),
    )
    .limit(1);

  if (rule) return rule.enabled ? rule : null;

  const fallback = defaultRuleState(category);
  return fallback.enabled ? fallback : null;
};
