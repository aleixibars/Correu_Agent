import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import type { ProviderMessage } from "../mail/types";
import { persistPolledMessages } from "./persist";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const MAILBOX_ID = "22222222-2222-2222-2222-222222222222";
const THREAD_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_THREAD_ID = "44444444-4444-4444-4444-444444444444";

const NOW = new Date("2026-01-02T10:00:00.000Z");

const message = (overrides: Partial<ProviderMessage> = {}): ProviderMessage => ({
  providerMessageId: "message-1",
  providerThreadId: "conversation-1",
  direction: "inbound",
  messageIdHeader: "<message-1@example.com>",
  inReplyTo: null,
  references: null,
  fromAddress: "client@example.com",
  toAddresses: ["bustia@example.com"],
  ccAddresses: [],
  subject: "Pressupost",
  snippet: "Bon dia,",
  bodyText: "Bon dia, voldria un pressupost.",
  bodyHtml: null,
  sentAt: new Date("2026-01-02T09:00:00.000Z"),
  ...overrides,
});

/** In the column order the thread upsert returns. */
const threadRow = (
  id: string,
  {
    category = null,
    triagedAt = null,
    created = true,
  }: { category?: string | null; triagedAt?: string | null; created?: boolean } = {},
) => [id, category, triagedAt, created];

/**
 * Drizzle's proxy driver builds every statement for real and hands it back
 * instead of reaching Neon, so the test asserts on what would be written.
 */
const createDb = ({
  threads = [threadRow(THREAD_ID)],
  insertedMessages = [["message-1"]] as unknown[][],
}: {
  threads?: unknown[][];
  insertedMessages?: unknown[][];
} = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  let threadInserts = 0;
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('insert into "threads"')) {
      return { rows: [threads[threadInserts++] ?? threadRow(THREAD_ID)] };
    }
    if (sql.includes('insert into "messages"')) return { rows: insertedMessages };
    return { rows: [] };
  });
  return { db, queries };
};

const inserts = (
  queries: { sql: string; params: unknown[] }[],
  table: string,
) => queries.filter(({ sql }) => sql.includes(`insert into "${table}"`));

describe("persistPolledMessages", () => {
  it("stores the thread, its messages and the audit entry", async () => {
    const { db, queries } = createDb();

    const persisted = await persistPolledMessages(db, {
      tenantId: TENANT_ID,
      mailboxAccountId: MAILBOX_ID,
      messages: [message()],
      now: NOW,
    });

    expect(persisted).toEqual([
      {
        threadId: THREAD_ID,
        providerThreadId: "conversation-1",
        category: null,
        triagedAt: null,
        threadCreated: true,
        newProviderMessageIds: ["message-1"],
      },
    ]);

    const [threadInsert] = inserts(queries, "threads");
    expect(threadInsert!.params).toEqual(
      expect.arrayContaining([TENANT_ID, MAILBOX_ID, "conversation-1"]),
    );

    const [messageInsert] = inserts(queries, "messages");
    expect(messageInsert!.sql).toContain(
      'on conflict ("thread_id","provider_message_id") do nothing',
    );
    // The full body is stored, not fetched from the provider again (context.md §7).
    expect(messageInsert!.params).toEqual(
      expect.arrayContaining([
        THREAD_ID,
        "message-1",
        "inbound",
        "client@example.com",
        "Bon dia, voldria un pressupost.",
      ]),
    );

    const [auditInsert] = inserts(queries, "audit_log_entries");
    expect(auditInsert!.params).toEqual(
      expect.arrayContaining([TENANT_ID, "system", "mail_received", THREAD_ID]),
    );
  });

  it("leaves the triage of a thread that already has one untouched", async () => {
    const { db, queries } = createDb({
      threads: [
        threadRow(THREAD_ID, {
          category: "comercial",
          triagedAt: "2026-01-01T08:00:00.000Z",
          created: false,
        }),
      ],
    });

    const [persisted] = await persistPolledMessages(db, {
      tenantId: TENANT_ID,
      mailboxAccountId: MAILBOX_ID,
      messages: [message({ providerMessageId: "message-2" })],
      now: NOW,
    });

    // A reply inside a triaged thread is stored, but the thread keeps its
    // category and is not queued for triage again (context.md §4).
    expect(persisted).toMatchObject({
      threadId: THREAD_ID,
      category: "comercial",
      triagedAt: new Date("2026-01-01T08:00:00.000Z"),
      threadCreated: false,
    });

    const { sql } = inserts(queries, "threads")[0]!;
    expect(sql).toContain(
      'on conflict ("mailbox_account_id","provider_thread_id") do update set',
    );
    // Only the do-update clause, not the returning list that follows it.
    const doUpdate = sql.slice(
      sql.indexOf("do update set"),
      sql.indexOf(" returning"),
    );
    expect(doUpdate).not.toContain('"category"');
    expect(doUpdate).not.toContain('"triaged_at"');
  });

  it("groups the mail of one poll by provider thread", async () => {
    const { db, queries } = createDb({
      threads: [threadRow(THREAD_ID), threadRow(OTHER_THREAD_ID)],
      insertedMessages: [["message-1"], ["message-2"]],
    });

    const persisted = await persistPolledMessages(db, {
      tenantId: TENANT_ID,
      mailboxAccountId: MAILBOX_ID,
      messages: [
        message(),
        message({
          providerMessageId: "message-3",
          providerThreadId: "conversation-2",
        }),
      ],
      now: NOW,
    });

    // Triage is per thread, so two conversations are two threads, however they
    // arrived (context.md §4).
    expect(inserts(queries, "threads")).toHaveLength(2);
    expect(persisted.map(({ providerThreadId }) => providerThreadId)).toEqual([
      "conversation-1",
      "conversation-2",
    ]);
  });

  it("does not record mail the poll had already stored", async () => {
    const { db, queries } = createDb({ insertedMessages: [] });

    const [persisted] = await persistPolledMessages(db, {
      tenantId: TENANT_ID,
      mailboxAccountId: MAILBOX_ID,
      messages: [message()],
      now: NOW,
    });

    // A poll that died after writing repeats itself (worker/src/poll): the same
    // message reaching here twice is normal, and must not look like new mail.
    expect(persisted!.newProviderMessageIds).toEqual([]);
    expect(inserts(queries, "audit_log_entries")).toEqual([]);
  });

  it("does nothing at all when the poll found no mail", async () => {
    const { db, queries } = createDb();

    await expect(
      persistPolledMessages(db, {
        tenantId: TENANT_ID,
        mailboxAccountId: MAILBOX_ID,
        messages: [],
        now: NOW,
      }),
    ).resolves.toEqual([]);
    expect(queries).toEqual([]);
  });
});
