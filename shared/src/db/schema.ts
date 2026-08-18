// Drizzle schema for the entities in context.md §7. Every multi-tenant table
// carries `tenantId` from day one so the second client isn't a painful
// migration, even though the PoC only ever has one tenant.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AUTO_REPLY_ELIGIBLE_CATEGORIES,
  TRIAGE_CATEGORIES,
} from "../triage/taxonomy";

export const mailProviderEnum = pgEnum("mail_provider", ["google", "microsoft"]);

export type MailProvider = (typeof mailProviderEnum.enumValues)[number];

/** The six fixed PoC categories (context.md §4), kept in sync with `TRIAGE_CATEGORIES`. */
export const triageCategoryEnum = pgEnum("triage_category", TRIAGE_CATEGORIES);

export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);

/**
 * Draft lifecycle (context.md §2): a pending draft is approved (and sent),
 * discarded, or regenerated — regenerating supersedes the previous draft so the
 * feedback trail stays intact.
 */
export const draftStatusEnum = pgEnum("draft_status", [
  "pending",
  "approved",
  "sent",
  "discarded",
  "superseded",
]);

export type DraftStatus = (typeof draftStatusEnum.enumValues)[number];

export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "system"]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// `defaultNow()` only fires on INSERT, so the column needs `$onUpdate` too —
// otherwise every row keeps its creation time forever.
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Dashboard login via Auth.js (context.md §9). */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    imageUrl: text("image_url"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.tenantId, table.email)],
);

/**
 * Auth.js account link for a dashboard login (context.md §9). Deliberately
 * holds no OAuth tokens: the dashboard only needs to recognise a returning
 * user, while the credentials used to read a mailbox live encrypted in
 * `mailboxAccounts`.
 */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Auth.js provider type, `"oidc"` for both Google and Microsoft Entra ID. */
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    createdAt: createdAt(),
  },
  // Globally unique, not per tenant: one identity provider account must never
  // resolve to two dashboard users.
  (table) => [unique().on(table.provider, table.providerAccountId)],
);

/** Auth.js database session (context.md §9) — no JWTs, so a logout is final. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("auth_sessions_user_idx").on(table.userId)],
);

/** A connected mailbox. Token columns hold ciphertext only (context.md §7). */
export const mailboxAccounts = pgTable(
  "mailbox_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    provider: mailProviderEnum("provider").notNull(),
    emailAddress: text("email_address").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    /** Gmail historyId / Graph delta link — where the next poll resumes from. */
    syncCursor: text("sync_cursor"),
    /** Only mail newer than this is processed (context.md §4). */
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.tenantId, table.provider, table.emailAddress)],
);

/** Triage unit: a Gmail thread / Graph conversation, never a single message (context.md §4). */
export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    mailboxAccountId: uuid("mailbox_account_id")
      .notNull()
      .references(() => mailboxAccounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject"),
    category: triageCategoryEnum("category"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique().on(table.mailboxAccountId, table.providerThreadId),
    index("threads_tenant_last_message_idx").on(
      table.tenantId,
      table.lastMessageAt,
    ),
    // The triage tick drains "which threads still have no category" every 2
    // minutes, and that set is tiny next to the threads already triaged — which
    // only ever grow. Partial, so the index stays the size of the backlog
    // instead of the size of the mailbox.
    index("threads_awaiting_triage_idx")
      .on(table.lastMessageAt)
      .where(sql`${table.triagedAt} is null`),
  ],
);

/**
 * Full mail body is stored (context.md §7); after the 90-day retention window
 * the body columns are nulled and `bodyPurgedAt` is stamped, leaving metadata,
 * category and summary behind.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    direction: messageDirectionEnum("direction").notNull(),
    /** RFC 5322 headers, needed so drafts reply inside the thread (context.md §4). */
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    fromAddress: text("from_address").notNull(),
    toAddresses: text("to_addresses").array().notNull().default(sql`'{}'`),
    ccAddresses: text("cc_addresses").array().notNull().default(sql`'{}'`),
    subject: text("subject"),
    snippet: text("snippet"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique().on(table.threadId, table.providerMessageId),
    index("messages_thread_sent_at_idx").on(table.threadId, table.sentAt),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** The message this draft answers — source of the In-Reply-To/References headers. */
    inReplyToMessageId: uuid("in_reply_to_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    status: draftStatusEnum("status").notNull().default("pending"),
    body: text("body").notNull(),
    /** Rejection feedback fed back into the model on regeneration (context.md §2). */
    feedback: text("feedback"),
    /** Set when the draft was produced by an auto-reply rule rather than on demand. */
    autoReply: boolean("auto_reply").notNull().default(false),
    model: text("model"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentMessageId: uuid("sent_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("drafts_tenant_status_idx").on(table.tenantId, table.status),
    // The dashboard thread list reads the live draft of each thread it shows,
    // one lookup per row — without this the list scans every draft in the
    // tenant for each thread on the page.
    index("drafts_thread_created_at_idx").on(table.threadId, table.createdAt),
    // One draft at a time waits for the user on a thread: the dashboard shows
    // a thread with its draft, and regenerating supersedes the one it replaces
    // rather than adding a second (context.md §2). Enforced here because the
    // generation job is a slow model call two workers can enter at once —
    // whoever inserts second is the one that must lose.
    uniqueIndex("drafts_thread_pending_idx")
      .on(table.threadId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/** Auto-reply is opt-in per category, never a global switch (context.md §2). */
export const autoReplyRules = pgTable(
  "auto_reply_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    category: triageCategoryEnum("category").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    instructions: text("instructions"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique().on(table.tenantId, table.category),
    // Urgent and personal are *never* auto-reply eligible (context.md §2). That
    // is the riskiest invariant in the product, so it is enforced in the
    // database rather than only in `isAutoReplyEligible`.
    check(
      "auto_reply_rules_eligible_category",
      // `sql.raw` because a CHECK constraint cannot hold bound parameters; the
      // values are compile-time constants, so there is nothing to inject.
      sql`NOT ${table.enabled} OR ${table.category} IN (${sql.raw(
        AUTO_REPLY_ELIGIBLE_CATEGORIES.map((category) => `'${category}'`).join(
          ", ",
        ),
      )})`,
    ),
  ],
);

/**
 * A browser that asked to be told about Urgent mail (context.md §5). Web Push is
 * the only active notification in the product; everything else waits for the
 * daily digest.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Whose browser this is — a subscription dies with the user who enabled it. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Push service URL the notification is sent to. */
    endpoint: text("endpoint").notNull(),
    /** Client public key and auth secret used to encrypt the payload. */
    p256dhKey: text("p256dh_key").notNull(),
    authKey: text("auth_key").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Unique on the endpoint alone, not per tenant: the push service already
  // issues one endpoint per browser, so the same one arriving again is that
  // browser re-subscribing, not a second subscription.
  (table) => [
    unique().on(table.endpoint),
    index("push_subscriptions_tenant_idx").on(table.tenantId),
  ],
);

/**
 * The daily digest of a day's triaged mail (context.md §2, §5). One row per
 * tenant per day, holding the prose the model wrote; the threads it summarises
 * are not copied into it, so the dashboard groups them straight from `threads`
 * and a later read never disagrees with the table it came from.
 */
export const dailyDigests = pgTable(
  "daily_digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The UTC calendar day covered, as `YYYY-MM-DD`. */
    digestDate: date("digest_date").notNull(),
    summary: text("summary").notNull(),
    /** How many threads the day's digest covers, for the dashboard's heading. */
    threadCount: integer("thread_count").notNull(),
    /** The model that wrote it, which is not always the one that was asked for. */
    model: text("model").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // One digest per day: a re-run overwrites the day it covers rather than
  // stacking a second summary of the same mail behind the first.
  (table) => [unique().on(table.tenantId, table.digestDate)],
);

/** "Why was this mail sent?" — every non-bookkeeping write lands here (context.md §7). */
export const auditLogEntries = pgTable(
  "audit_log_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    threadId: uuid("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    draftId: uuid("draft_id").references(() => drafts.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_log_entries_tenant_created_at_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    // "Why was this mail sent?" is asked about one thread, so the trail is read
    // by thread far more often than it is scanned tenant-wide.
    index("audit_log_entries_thread_created_at_idx").on(
      table.threadId,
      table.createdAt,
    ),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthAccount = typeof authAccounts.$inferSelect;
export type NewAuthAccount = typeof authAccounts.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
export type MailboxAccount = typeof mailboxAccounts.$inferSelect;
export type NewMailboxAccount = typeof mailboxAccounts.$inferInsert;
export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Draft = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;
export type AutoReplyRule = typeof autoReplyRules.$inferSelect;
export type NewAutoReplyRule = typeof autoReplyRules.$inferInsert;
export type AuditLogEntry = typeof auditLogEntries.$inferSelect;
export type NewAuditLogEntry = typeof auditLogEntries.$inferInsert;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;
export type DailyDigest = typeof dailyDigests.$inferSelect;
export type NewDailyDigest = typeof dailyDigests.$inferInsert;
