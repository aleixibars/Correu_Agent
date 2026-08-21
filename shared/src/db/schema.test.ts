import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  AUTO_DISCARD_ELIGIBLE_CATEGORIES,
  AUTO_REPLY_ELIGIBLE_CATEGORIES,
  TRIAGE_CATEGORIES,
} from "../triage/taxonomy";
import {
  auditLogEntries,
  authAccounts,
  authSessions,
  autoDiscardRules,
  autoReplyRules,
  dailyDigests,
  drafts,
  mailboxAccounts,
  messages,
  tenants,
  threads,
  triageCategoryEnum,
  users,
} from "./schema";

/** Every table except `tenants` itself is scoped to a tenant (context.md §7). */
const TENANT_SCOPED_TABLES: Record<string, PgTable> = {
  users,
  authAccounts,
  authSessions,
  mailboxAccounts,
  messages,
  threads,
  drafts,
  autoReplyRules,
  autoDiscardRules,
  auditLogEntries,
  dailyDigests,
};

const columnNames = (table: PgTable): string[] =>
  getTableConfig(table).columns.map((column) => column.name);

/** Tables whose `updated_at` should track the last write, not the insert. */
const TABLES_WITH_UPDATED_AT: Record<string, PgTable> = {
  tenants,
  users,
  mailboxAccounts,
  threads,
  drafts,
  autoReplyRules,
  autoDiscardRules,
  dailyDigests,
};

describe("schema", () => {
  it("names tables in snake_case", () => {
    expect(getTableConfig(tenants).name).toBe("tenants");
    expect(getTableConfig(mailboxAccounts).name).toBe("mailbox_accounts");
    expect(getTableConfig(auditLogEntries).name).toBe("audit_log_entries");
  });

  it.each(Object.keys(TENANT_SCOPED_TABLES))(
    "gives %s a non-null tenant_id column",
    (name) => {
      const table = TENANT_SCOPED_TABLES[name]!;
      const tenantId = getTableConfig(table).columns.find(
        (column) => column.name === "tenant_id",
      );
      expect(tenantId).toBeDefined();
      expect(tenantId!.notNull).toBe(true);
    },
  );

  it.each(Object.keys(TENANT_SCOPED_TABLES))(
    "points %s.tenant_id at the tenants table",
    (name) => {
      const table = TENANT_SCOPED_TABLES[name]!;
      const references = getTableConfig(table)
        .foreignKeys.map((fk) => fk.reference())
        .filter((reference) =>
          reference.columns.some((column) => column.name === "tenant_id"),
        );
      expect(references).toHaveLength(1);
      expect(getTableConfig(references[0]!.foreignTable).name).toBe("tenants");
    },
  );

  it.each(Object.keys(TABLES_WITH_UPDATED_AT))(
    "bumps %s.updated_at on every write, not just on insert",
    (name) => {
      const updatedAt = getTableConfig(TABLES_WITH_UPDATED_AT[name]!).columns.find(
        (column) => column.name === "updated_at",
      );
      expect(updatedAt?.onUpdateFn).toBeTypeOf("function");
      expect(updatedAt!.onUpdateFn!()).toBeInstanceOf(Date);
    },
  );

  it("stamps when a mailbox was connected, since only newer mail is processed", () => {
    // The connection time is the processing watermark (context.md §4), so it
    // gets a column that says so rather than riding on a generic `created_at`.
    expect(columnNames(mailboxAccounts)).toContain("connected_at");
  });

  it("uses the six fixed triage categories as the category enum", () => {
    expect(triageCategoryEnum.enumValues).toEqual([...TRIAGE_CATEGORIES]);
  });

  it("stores OAuth tokens in columns marked as encrypted", () => {
    const names = columnNames(mailboxAccounts);
    expect(names).toContain("access_token_encrypted");
    expect(names).toContain("refresh_token_encrypted");
    expect(names).not.toContain("access_token");
    expect(names).not.toContain("refresh_token");
  });

  it("keys threads by the provider thread/conversation id, once per mailbox", () => {
    const config = getTableConfig(threads);
    expect(columnNames(threads)).toContain("provider_thread_id");
    const unique = config.uniqueConstraints.find((constraint) =>
      constraint.columns.some((column) => column.name === "provider_thread_id"),
    );
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "mailbox_account_id",
      "provider_thread_id",
    ]);
  });

  it("keeps messages unique per provider message id within a thread", () => {
    const unique = getTableConfig(messages).uniqueConstraints.find(
      (constraint) =>
        constraint.columns.some(
          (column) => column.name === "provider_message_id",
        ),
    );
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "thread_id",
      "provider_message_id",
    ]);
  });

  it("keeps the reply headers needed to answer inside a thread", () => {
    const names = columnNames(messages);
    expect(names).toContain("message_id_header");
    expect(names).toContain("in_reply_to");
    expect(names).toContain("references");
  });

  it("stores the mail body for the retention window and records the purge", () => {
    const names = columnNames(messages);
    expect(names).toContain("body_text");
    expect(names).toContain("body_html");
    expect(names).toContain("body_purged_at");
  });

  it("allows at most one auto-reply rule per category per tenant", () => {
    const unique = getTableConfig(autoReplyRules).uniqueConstraints[0];
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "category",
    ]);
  });

  it("refuses an enabled auto-reply rule on an ineligible category", () => {
    // Urgent and personal are never auto-reply eligible (context.md §2) — the
    // database has to say so too, not just `isAutoReplyEligible`.
    const checks = getTableConfig(autoReplyRules).checks;
    expect(checks).toHaveLength(1);

    const constraint = new PgDialect().sqlToQuery(checks[0]!.value);
    expect(constraint.params).toEqual([]);
    for (const category of TRIAGE_CATEGORIES) {
      const eligible = AUTO_REPLY_ELIGIBLE_CATEGORIES.includes(category);
      expect(constraint.sql.includes(`'${category}'`)).toBe(eligible);
    }
  });

  it("defaults auto-reply rules to disabled", () => {
    const enabled = getTableConfig(autoReplyRules).columns.find(
      (column) => column.name === "enabled",
    );
    expect(enabled?.default).toBe(false);
  });

  it("allows at most one auto-discard rule per category per tenant", () => {
    const unique = getTableConfig(autoDiscardRules).uniqueConstraints[0];
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "category",
    ]);
  });

  it("refuses an enabled auto-discard rule on urgent, the one ineligible category", () => {
    // Urgent mail must always reach a human — the database has to say so too,
    // not just `isAutoDiscardEligible`.
    const checks = getTableConfig(autoDiscardRules).checks;
    expect(checks).toHaveLength(1);

    const constraint = new PgDialect().sqlToQuery(checks[0]!.value);
    expect(constraint.params).toEqual([]);
    for (const category of TRIAGE_CATEGORIES) {
      const eligible = AUTO_DISCARD_ELIGIBLE_CATEGORIES.includes(category);
      expect(constraint.sql.includes(`'${category}'`)).toBe(eligible);
    }
  });

  it("defaults auto-discard rules to disabled", () => {
    // The column default is off for every category; the code-level default that
    // turns newsletter on with no row stored lives in `listAutoDiscardRules` /
    // `findEnabledAutoDiscardRule`, not here.
    const columns = getTableConfig(autoDiscardRules).columns;
    expect(columns.find((column) => column.name === "enabled")?.default).toBe(
      false,
    );
  });

  it("scopes user emails to a tenant rather than globally", () => {
    const unique = getTableConfig(users).uniqueConstraints[0];
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "email",
    ]);
  });

  it("links an Auth.js account to a single user, once per provider account", () => {
    const config = getTableConfig(authAccounts);
    expect(config.uniqueConstraints[0]?.columns.map((column) => column.name)).toEqual(
      ["provider", "provider_account_id"],
    );
    const userReference = config.foreignKeys
      .map((fk) => fk.reference())
      .find((reference) =>
        reference.columns.some((column) => column.name === "user_id"),
      );
    expect(getTableConfig(userReference!.foreignTable).name).toBe("users");
  });

  it("keeps OAuth tokens out of the dashboard login accounts", () => {
    // Login accounts only carry the provider link; mailbox credentials live in
    // `mailbox_accounts`, encrypted (context.md §7).
    const names = columnNames(authAccounts);
    expect(names).not.toContain("access_token");
    expect(names).not.toContain("refresh_token");
    expect(names).not.toContain("id_token");
  });

  it("keys a login session by its token and stores when it expires", () => {
    const config = getTableConfig(authSessions);
    expect(config.columns.filter((column) => column.primary).map((c) => c.name)).toEqual(
      ["session_token"],
    );
    const expires = config.columns.find((column) => column.name === "expires");
    expect(expires?.notNull).toBe(true);
  });

  it("allows at most one digest per tenant per day", () => {
    // A day is digested again when it is corrected, never digested twice
    // (context.md §2).
    const unique = getTableConfig(dailyDigests).uniqueConstraints[0];
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "digest_date",
    ]);
  });

  it("dates a digest by calendar day, not by the moment it was written", () => {
    const digestDate = getTableConfig(dailyDigests).columns.find(
      (column) => column.name === "digest_date",
    );
    expect(digestDate?.getSQLType()).toBe("date");
    expect(digestDate?.notNull).toBe(true);
  });

  it("records what an audit entry is about", () => {
    const names = columnNames(auditLogEntries);
    expect(names).toEqual(
      expect.arrayContaining([
        "action",
        "actor_user_id",
        "thread_id",
        "draft_id",
        "metadata",
        "created_at",
      ]),
    );
  });

  it("tracks draft lifecycle state and the feedback used to regenerate", () => {
    const names = columnNames(drafts);
    expect(names).toEqual(
      expect.arrayContaining([
        "status",
        "body",
        "feedback",
        "in_reply_to_message_id",
        "sent_at",
      ]),
    );
  });
});
