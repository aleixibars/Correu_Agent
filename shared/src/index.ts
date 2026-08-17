// Shared types and constants used by both `app/` and `worker/`.
// The Drizzle schema (context.md §7: Tenant, User, MailboxAccount, Thread,
// Message, Draft, AutoReplyRule, AuditLogEntry) lands here as it's built out
// issue by issue — this file is the seam, not the final shape.

export const APP_NAME = "Correu Agent";

export {
  TOKEN_ENCRYPTION_KEY_ENV,
  decryptToken,
  encryptToken,
  loadTokenEncryptionKey,
} from "./token-encryption";

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
