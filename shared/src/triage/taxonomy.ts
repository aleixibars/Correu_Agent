// Triage taxonomy (context.md §4), shared by the classifier, the schema and the
// dashboard.

/** The six fixed triage categories for the PoC (context.md §4). Order matters for dashboard display. */
export const TRIAGE_CATEGORIES = [
  "urgent",
  "comercial",
  "suport",
  "facturacio",
  "newsletter",
  "personal",
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** Categories where auto-reply (context.md §2) is allowed to be enabled at all. */
export const AUTO_REPLY_ELIGIBLE_CATEGORIES: readonly TriageCategory[] = [
  "comercial",
  "suport",
  "facturacio",
];

export const isAutoReplyEligible = (category: TriageCategory): boolean =>
  AUTO_REPLY_ELIGIBLE_CATEGORIES.includes(category);

/**
 * Categories a reply draft is written for (context.md §2). Newsletters and spam
 * are the one kind of mail nobody answers — they are archived or labelled — so
 * they are the only category left out. `personal` stays in: it is the catch-all
 * the classifier falls back to, and dropping it would silently skip business
 * mail that landed there.
 */
export const DRAFT_ELIGIBLE_CATEGORIES: readonly TriageCategory[] =
  TRIAGE_CATEGORIES.filter((category) => category !== "newsletter");

export const needsDraft = (category: TriageCategory): boolean =>
  DRAFT_ELIGIBLE_CATEGORIES.includes(category);

/**
 * Categories where automatic discard is allowed to be enabled at all. Urgent is
 * the one category that must always reach a human — the same invariant
 * `AUTO_REPLY_ELIGIBLE_CATEGORIES` enforces on the opposite action, so it is the
 * only one excluded here too.
 */
export const AUTO_DISCARD_ELIGIBLE_CATEGORIES: readonly TriageCategory[] =
  TRIAGE_CATEGORIES.filter((category) => category !== "urgent");

export const isAutoDiscardEligible = (category: TriageCategory): boolean =>
  AUTO_DISCARD_ELIGIBLE_CATEGORIES.includes(category);
