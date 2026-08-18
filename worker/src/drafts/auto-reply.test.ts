import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "@correu-agent/shared/token-encryption";
import { createThreadAutoReplySender } from "./auto-reply";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const DRAFT_ID = "33333333-3333-3333-3333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-4444-444444444444";
const SENT_MESSAGE_ID = "55555555-5555-5555-5555-555555555555";

const NOW = new Date("2026-01-02T10:00:00.000Z");

const encryptionKey = randomBytes(32);

const config = {
  google: { credentials: { clientId: "id", clientSecret: "secret" }, encryptionKey },
  microsoft: {
    clientId: "id",
    clientSecret: "secret",
    encryptionKey,
  },
};

/** In the column order `loadPollableMailboxAccount` asks for. */
const accountRow = (provider = "google") => [
  ACCOUNT_ID,
  TENANT_ID,
  provider,
  "bustia@example.com",
  encryptToken("access-1", encryptionKey),
  encryptToken("refresh-1", encryptionKey),
  // Long-lived, so this send mints no token — refreshing is the poll's path.
  "2099-01-01T00:00:00.000Z",
  "1000",
  "2026-01-01T00:00:00.000Z",
];

/** In the column order the send's draft select asks for. */
const draftRow = () => [
  "pending",
  "Bon dia,\n\nUs enviem el pressupost.",
  THREAD_ID,
  "Pressupost",
  "provider-thread-1",
  "bustia@example.com",
  "provider-message-1",
  "<client@mail.example.com>",
  null,
  null,
  "client@example.com",
  "Pressupost",
  "comercial",
];

const createDb = ({
  mailboxAccountId = ACCOUNT_ID as string | null,
  account = accountRow() as unknown[] | null,
}: { mailboxAccountId?: string | null; account?: unknown[] | null } = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "threads"')) {
      return { rows: mailboxAccountId ? [[mailboxAccountId]] : [] };
    }
    if (sql.includes('from "mailbox_accounts"')) {
      return { rows: account ? [account] : [] };
    }
    if (sql.includes('from "auto_reply_rules"')) {
      return { rows: [["comercial", true, null]] };
    }
    if (sql.startsWith("select") && sql.includes('from "drafts"')) {
      return { rows: [draftRow()] };
    }
    if (sql.startsWith('update "drafts"')) return { rows: [[DRAFT_ID]] };
    if (sql.includes('insert into "messages"')) return { rows: [[SENT_MESSAGE_ID]] };
    return { rows: [] };
  });
  return { db, queries };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const gmailSends = () => {
  const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    Response.json({ id: "provider-sent-1", threadId: "provider-thread-1" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("createThreadAutoReplySender", () => {
  it("sends the draft through the provider the thread's mailbox is connected to", async () => {
    const { db, queries } = createDb();
    const fetchMock = gmailSends();

    const sent = await createThreadAutoReplySender({ db, ...config })({
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      draftId: DRAFT_ID,
      now: NOW,
    });

    expect(sent).toMatchObject({
      draftId: DRAFT_ID,
      threadId: THREAD_ID,
      sentMessageId: SENT_MESSAGE_ID,
      providerMessageId: "provider-sent-1",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/messages/send");

    // The trail says a rule sent it, not a person (context.md §7).
    const audit = queries.find(({ sql }) =>
      sql.includes('insert into "audit_log_entries"'),
    )!;
    expect(audit.params).toContain("auto_reply_sent");
  });

  it("sends nothing when the mailbox was disconnected after the draft was written", async () => {
    const { db } = createDb({ account: null });
    const fetchMock = gmailSends();

    await expect(
      createThreadAutoReplySender({ db, ...config })({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        draftId: DRAFT_ID,
        now: NOW,
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a provider it has no sender for", async () => {
    const { db } = createDb({ account: accountRow("imap") });
    gmailSends();

    await expect(
      createThreadAutoReplySender({ db, ...config })({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        draftId: DRAFT_ID,
        now: NOW,
      }),
    ).rejects.toThrow(/imap/);
  });
});
