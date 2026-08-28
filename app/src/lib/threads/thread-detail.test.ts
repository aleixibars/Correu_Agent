import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { loadThreadDetail } from "./thread-detail";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "55555555-5555-5555-5555-555555555555";
const OTHER_TENANT_ID = "99999999-9999-9999-9999-999999999999";

/**
 * Drizzle's proxy driver: the statements are built for real and captured
 * instead of reaching Postgres, so the test asserts on what would actually be
 * queried. Rows are answered in the order the reads are issued.
 */
const recordingDatabase = (results: unknown[][][]) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    return { rows: results[statements.length - 1] ?? [] };
  });
  return { db, statements };
};

/** In the column order the thread select asks for. */
const threadRow = (
  overrides: Partial<{
    subject: string | null;
    category: string | null;
    triagedAt: string | null;
    lastMessageAt: string | null;
  }> = {},
): unknown[] => {
  const values = {
    subject: "Pressupost",
    category: "comercial",
    triagedAt: "2026-08-18 09:00:00+00",
    lastMessageAt: "2026-08-18 08:30:00+00",
    ...overrides,
  };
  return [
    THREAD_ID,
    values.subject,
    values.category,
    values.triagedAt,
    values.lastMessageAt,
  ];
};

/** In the column order the draft select asks for. */
const draftRow = (
  status = "pending",
  recipients: Partial<{
    toAddresses: string[];
    ccAddresses: string[];
    bccAddresses: string[];
  }> = {},
): unknown[] => [
  "77777777-7777-7777-7777-777777777777",
  "Bon dia, us passem el pressupost.",
  status,
  "claude-sonnet-5",
  "2026-08-18 09:05:00+00",
  null,
  recipients.toAddresses ?? [],
  recipients.ccAddresses ?? [],
  recipients.bccAddresses ?? [],
  "client@example.com",
];

/** In the column order the message select asks for. */
const messageRow = (
  overrides: Partial<{
    id: string;
    direction: string;
    fromAddress: string;
    bodyText: string | null;
    snippet: string | null;
    sentAt: string | null;
  }> = {},
): unknown[] => {
  const values = {
    id: "22222222-2222-2222-2222-222222222222",
    direction: "inbound",
    fromAddress: "client@example.com",
    bodyText: "Ens podeu passar un pressupost?",
    snippet: "Ens podeu passar",
    sentAt: "2026-08-18 08:30:00+00",
    ...overrides,
  };
  return [
    values.id,
    values.direction,
    values.fromAddress,
    ["bustia@example.com"],
    "Pressupost",
    values.bodyText,
    values.snippet,
    values.sentAt,
  ];
};

describe("loadThreadDetail", () => {
  it("reads the thread of the tenant alone", async () => {
    const { db, statements } = recordingDatabase([[threadRow()], [], []]);

    await loadThreadDetail(db, { tenantId: TENANT_ID, threadId: THREAD_ID });

    const { sql, params } = statements[0]!;
    expect(sql).toContain('from "threads"');
    expect(sql).toContain('"threads"."tenant_id" = ');
    expect(params).toContain(TENANT_ID);
    expect(params).toContain(THREAD_ID);
  });

  // A thread id is a URL segment, so it is arbitrary input: another tenant's
  // thread must read as missing rather than as readable.
  it("answers with null when the thread is not the tenant's", async () => {
    const { db, statements } = recordingDatabase([[]]);

    const detail = await loadThreadDetail(db, {
      tenantId: OTHER_TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(detail).toBeNull();
    // Nothing else is read: no draft body of a thread the tenant cannot see.
    expect(statements).toHaveLength(1);
  });

  // A mistyped or stale link is a `/fils/<anything>` request: Postgres refuses
  // a malformed uuid outright, which would be a 500 where a 404 belongs.
  it("answers with null for an id no thread could have", async () => {
    const { db, statements } = recordingDatabase([[threadRow()]]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: "no-un-fil",
    });

    expect(detail).toBeNull();
    expect(statements).toHaveLength(0);
  });

  it("answers with the thread, its mail and its live draft", async () => {
    const { db } = recordingDatabase([
      [threadRow()],
      [draftRow()],
      [messageRow()],
    ]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(detail).toMatchObject({
      id: THREAD_ID,
      subject: "Pressupost",
      category: "comercial",
      status: "draft-pending",
      draft: {
        id: "77777777-7777-7777-7777-777777777777",
        body: "Bon dia, us passem el pressupost.",
        status: "pending",
      },
    });
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]).toMatchObject({
      direction: "inbound",
      fromAddress: "client@example.com",
      bodyText: "Ens podeu passar un pressupost?",
      sentAt: new Date("2026-08-18T08:30:00.000Z"),
    });
  });

  // The approval form starts from the addresses the reply would leave with
  // (context.md §2), so the reviewer sees what they are editing.
  it("starts a pending draft's recipients from the mail it answers", async () => {
    const { db } = recordingDatabase([
      [threadRow()],
      [draftRow()],
      [messageRow()],
    ]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(detail?.draft).toMatchObject({
      toAddresses: ["client@example.com"],
      ccAddresses: [],
      bccAddresses: [],
    });
  });

  // Once the mail has left, the fields hold who it really went to — which is
  // not the same thing as who it would have gone to (context.md §7).
  it("shows a sent draft's own recipients instead of the thread's", async () => {
    const { db } = recordingDatabase([
      [threadRow()],
      [
        draftRow("sent", {
          toAddresses: ["altre@example.com"],
          ccAddresses: ["copia@example.com"],
          bccAddresses: ["arxiu@example.com"],
        }),
      ],
      [messageRow()],
    ]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(detail?.draft).toMatchObject({
      toAddresses: ["altre@example.com"],
      ccAddresses: ["copia@example.com"],
      bccAddresses: ["arxiu@example.com"],
    });
  });

  it("hangs each attachment on the message it arrived with", async () => {
    const { db, statements } = recordingDatabase([
      [threadRow()],
      [],
      // Newest first, as the query asks for them.
      [
        messageRow({ id: "msg-2", sentAt: "2026-08-18 08:30:00+00" }),
        messageRow({ id: "msg-1", sentAt: "2026-08-17 08:30:00+00" }),
      ],
      [
        ["att-1", "msg-2", "pressupost.pdf", "application/pdf", 20480],
        ["att-2", "msg-1", "comandes.csv", "text/csv", null],
      ],
    ]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    const { sql, params } = statements[3]!;
    expect(sql).toContain('from "message_attachments"');
    // Read for the mail of this thread alone, which is already tenant-checked.
    expect(params).toEqual(expect.arrayContaining(["msg-1", "msg-2"]));
    // Signature logos are embedded in the body, not files the sender attached.
    expect(sql).toContain('"message_attachments"."inline" = ');
    expect(detail?.messages.map(({ id, attachments }) => [id, attachments])).toEqual([
      [
        "msg-1",
        [
          {
            id: "att-2",
            filename: "comandes.csv",
            mimeType: "text/csv",
            sizeBytes: null,
          },
        ],
      ],
      [
        "msg-2",
        [
          {
            id: "att-1",
            filename: "pressupost.pdf",
            mimeType: "application/pdf",
            sizeBytes: 20480,
          },
        ],
      ],
    ]);
  });

  it("does not read attachments for a thread with no mail left to show", async () => {
    const { db, statements } = recordingDatabase([[threadRow()], [], []]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(detail?.messages).toEqual([]);
    expect(statements).toHaveLength(3);
  });

  // A regeneration supersedes the draft it replaces (context.md §2): showing it
  // would offer the user a text that is no longer the thread's answer.
  it("skips superseded drafts when reading the live one", async () => {
    const { db, statements } = recordingDatabase([
      [threadRow()],
      [draftRow()],
      [],
    ]);

    await loadThreadDetail(db, { tenantId: TENANT_ID, threadId: THREAD_ID });

    const { sql, params } = statements[1]!;
    expect(sql).toContain('from "drafts"');
    expect(sql).toContain('"drafts"."status" <> ');
    expect(params).toContain("superseded");
    expect(sql).toContain('order by "drafts"."created_at" desc');
  });

  it("reads the newest mail of the thread and shows it oldest first", async () => {
    const { db, statements } = recordingDatabase([
      [threadRow()],
      [],
      [
        messageRow({ id: "msg-new", sentAt: "2026-08-18 08:30:00+00" }),
        messageRow({ id: "msg-old", sentAt: "2026-08-17 08:30:00+00" }),
      ],
    ]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    const { sql } = statements[2]!;
    expect(sql).toContain('from "messages"');
    expect(sql).toContain("desc");
    expect(sql).toContain("limit");
    expect(detail?.messages.map(({ id }) => id)).toEqual(["msg-old", "msg-new"]);
  });

  it("reports a thread with no draft as triaged", async () => {
    const { db } = recordingDatabase([[threadRow()], [], [messageRow()]]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(detail?.draft).toBeNull();
    expect(detail?.status).toBe("triaged");
  });

  it("reports a thread the triage tick has not reached yet", async () => {
    const { db } = recordingDatabase([
      [threadRow({ triagedAt: null, category: null })],
      [],
      [],
    ]);

    const detail = await loadThreadDetail(db, {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });

    expect(detail?.status).toBe("awaiting-triage");
    expect(detail?.category).toBeNull();
  });
});
