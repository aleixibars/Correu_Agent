import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TRIAGE_CATEGORIES } from "../triage";
import {
  auditLogEntries,
  autoReplyRules,
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
  mailboxAccounts,
  messages,
  threads,
  drafts,
  autoReplyRules,
  auditLogEntries,
};

const columnNames = (table: PgTable): string[] =>
  getTableConfig(table).columns.map((column) => column.name);

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

  it("defaults auto-reply rules to disabled", () => {
    const enabled = getTableConfig(autoReplyRules).columns.find(
      (column) => column.name === "enabled",
    );
    expect(enabled?.default).toBe(false);
  });

  it("scopes user emails to a tenant rather than globally", () => {
    const unique = getTableConfig(users).uniqueConstraints[0];
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "email",
    ]);
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
