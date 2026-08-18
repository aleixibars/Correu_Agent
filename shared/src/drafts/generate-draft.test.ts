import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import { DRAFT_MODEL, type DraftMessagesClient } from "./generate";
import { generateThreadDraft } from "./generate-draft";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333";
const DRAFT_ID = "44444444-4444-4444-4444-444444444444";

const NOW = new Date("2026-01-02T10:00:00.000Z");

const REPLY = { language: "ca", body: "Bon dia,\n\nUs enviem el pressupost." };

const createClient = (text = JSON.stringify(REPLY)) => {
  const create = vi.fn(
    async (_params: Anthropic.MessageCreateParamsNonStreaming) =>
      ({
        model: DRAFT_MODEL,
        content: [{ type: "text", text }],
      }) as unknown as Anthropic.Message,
  );
  return { client: { create } as unknown as DraftMessagesClient, create };
};

/** In the column order the thread select asks for: subject, category, triagedAt. */
const threadRow = ({
  category = "comercial" as string | null,
  triagedAt = "2026-01-02T09:00:00.000Z" as string | null,
} = {}) => ["Pressupost", category, triagedAt];

/** In the column order the message select asks for. */
const messageRow = ({
  id = MESSAGE_ID,
  direction = "inbound",
  bodyText = "Voldríem un pressupost." as string | null,
  messageIdHeader = "<client@mail.example.com>" as string | null,
  references = null as string | null,
} = {}) => [
  id,
  direction,
  "client@example.com",
  "Pressupost",
  bodyText,
  "Voldríem un pressupost",
  messageIdHeader,
  null,
  references,
];

const createDb = ({
  thread = threadRow(),
  messages = [messageRow()],
  existingDrafts = [] as unknown[][],
  inserted = [[DRAFT_ID]] as unknown[][],
  rule = [] as unknown[][],
}: {
  thread?: unknown[] | null;
  messages?: unknown[][];
  existingDrafts?: unknown[][];
  inserted?: unknown[][];
  rule?: unknown[][];
} = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "auto_reply_rules"')) return { rows: rule };
    if (sql.includes('from "threads"')) return { rows: thread ? [thread] : [] };
    if (sql.includes('from "messages"')) return { rows: messages };
    if (sql.includes('from "drafts"')) return { rows: existingDrafts };
    if (sql.includes('insert into "drafts"')) return { rows: inserted };
    return { rows: [] };
  });
  return { db, queries };
};

const shape = (sql: string): string => {
  if (sql.includes('from "auto_reply_rules"')) return "load rule";
  if (sql.includes('from "threads"')) return "load thread";
  if (sql.includes('from "messages"')) return "load messages";
  if (sql.includes('from "drafts"')) return "load drafts";
  if (sql.includes('insert into "drafts"')) return "store draft";
  if (sql.includes('insert into "audit_log_entries"')) return "audit";
  return "other";
};

describe("generateThreadDraft", () => {
  it("stores the reply the model wrote and audits it", async () => {
    const { db, queries } = createDb();
    const { client, create } = createClient();

    const result = await generateThreadDraft(db, client, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      now: NOW,
    });

    expect(result).toEqual({
      threadId: THREAD_ID,
      draftId: DRAFT_ID,
      inReplyToMessageId: MESSAGE_ID,
      // The draft answers inside the thread, never as a new mail (context.md §4).
      replyHeaders: {
        inReplyTo: "<client@mail.example.com>",
        references: "<client@mail.example.com>",
      },
      language: "ca",
      model: DRAFT_MODEL,
      // No rule is on, so the draft waits for the dashboard (context.md §2).
      autoReply: false,
    });
    expect(queries.map(({ sql }) => shape(sql))).toEqual([
      "load thread",
      "load messages",
      "load drafts",
      "load rule",
      "store draft",
      "audit",
    ]);
    expect(create).toHaveBeenCalledOnce();

    const insert = queries.find(({ sql }) =>
      sql.includes('insert into "drafts"'),
    )!;
    expect(insert.params).toContain(REPLY.body);
    expect(insert.params).toContain(MESSAGE_ID);
    expect(insert.params).toContain(DRAFT_MODEL);

    const audit = queries.find(({ sql }) =>
      sql.includes('insert into "audit_log_entries"'),
    )!;
    expect(audit.params).toContain("draft_generated");
    expect(audit.params).toContain(DRAFT_ID);
    // Which language the reply was written in is part of "why was this mail
    // sent" (context.md §6, §7).
    expect(audit.params.join(" ")).toContain('"language":"ca"');
  });

  it("carries the thread's chain into the reply's References", async () => {
    const { db } = createDb({
      messages: [
        messageRow({ references: "<first@mail.example.com>" }),
        messageRow({ id: "older", direction: "outbound" }),
      ],
    });
    const { client } = createClient();

    const result = await generateThreadDraft(db, client, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(result?.replyHeaders).toEqual({
      inReplyTo: "<client@mail.example.com>",
      references: "<first@mail.example.com> <client@mail.example.com>",
    });
  });

  it("waits for triage before answering a thread", async () => {
    const { db, queries } = createDb({
      thread: threadRow({ category: null, triagedAt: null }),
    });
    const { client, create } = createClient();

    await expect(
      generateThreadDraft(db, client, {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(queries.map(({ sql }) => shape(sql))).toEqual(["load thread"]);
  });

  it("never answers a newsletter", async () => {
    // Newsletters and spam are archived or labelled, not replied to (context.md §2).
    const { db } = createDb({ thread: threadRow({ category: "newsletter" }) });
    const { client, create } = createClient();

    await expect(
      generateThreadDraft(db, client, {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves a thread whose last word is the mailbox's own alone", async () => {
    const { db } = createDb({
      messages: [messageRow({ direction: "outbound" }), messageRow()],
    });
    const { client, create } = createClient();

    await expect(
      generateThreadDraft(db, client, {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("waits for the mail of a thread the poll has not stored yet", async () => {
    // The poll writes the thread row and its messages as two statements, so a
    // tick can land between them. Drafting from a subject line would spend a
    // Sonnet call on nothing.
    const { db } = createDb({ messages: [] });
    const { client, create } = createClient();

    await expect(
      generateThreadDraft(db, client, {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not draft the same mail twice", async () => {
    // A draft the user discarded must not come back on the next tick.
    const { db, queries } = createDb({ existingDrafts: [[DRAFT_ID]] });
    const { client, create } = createClient();

    await expect(
      generateThreadDraft(db, client, {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(queries.map(({ sql }) => shape(sql))).toEqual([
      "load thread",
      "load messages",
      "load drafts",
    ]);
  });

  it("waits for the draft the user still has open before drafting newer mail", async () => {
    // The thread holds one pending draft at a time (`drafts_thread_pending_idx`),
    // so the insert would lose anyway — asking Sonnet first would pay for a row
    // that cannot be written, every two minutes, until the user answers it.
    const { db, queries } = createDb({ existingDrafts: [[DRAFT_ID]] });
    const { client, create } = createClient();

    await expect(
      generateThreadDraft(db, client, {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();

    const load = queries.find(({ sql }) => sql.includes('from "drafts"'))!;
    expect(load.params).toContain("pending");
  });

  it("writes nothing when another worker stored the draft first", async () => {
    const { db, queries } = createDb({ inserted: [] });
    const { client } = createClient();

    await expect(
      generateThreadDraft(db, client, {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeNull();
    // One pending draft per thread; the loser audits nothing.
    expect(queries.map(({ sql }) => shape(sql))).not.toContain("audit");
  });

  it("marks the draft of a category whose auto-reply rule is on", async () => {
    const { db, queries } = createDb({
      rule: [["comercial", true, "Ofereix sempre una trucada de seguiment."]],
    });
    const { client, create } = createClient();

    const result = await generateThreadDraft(db, client, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      now: NOW,
    });

    expect(result?.autoReply).toBe(true);
    // The rule's own instructions are what the reply is written under.
    expect(String(create.mock.calls[0]![0].messages[0]!.content)).toContain(
      "Ofereix sempre una trucada de seguiment.",
    );

    const insert = queries.find(({ sql }) =>
      sql.includes('insert into "drafts"'),
    )!;
    expect(insert.params).toContain(true);

    // "Why was this mail sent" starts here: the draft says a rule asked for it,
    // not a person (context.md §7).
    const audit = queries.find(({ sql }) =>
      sql.includes('insert into "audit_log_entries"'),
    )!;
    expect(audit.params.join(" ")).toContain('"autoReply":true');
  });

  it("never reads a rule for a category auto-reply can never apply to", async () => {
    // Urgent is the one nobody may answer unread (context.md §2, §4).
    const { db, queries } = createDb({ thread: threadRow({ category: "urgent" }) });
    const { client } = createClient();

    const result = await generateThreadDraft(db, client, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      now: NOW,
    });

    expect(result?.autoReply).toBe(false);
    expect(queries.map(({ sql }) => shape(sql))).not.toContain("load rule");
  });
});
