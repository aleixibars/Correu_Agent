import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptToken,
  encryptToken,
} from "@correu-agent/shared/token-encryption";
import { listGmailPollTargets, pollGmailMailbox } from "./gmail-poll";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const MAILBOX_ID = "33333333-3333-3333-3333-333333333333";

const CREDENTIALS = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
};

const encryptionKey = randomBytes(32);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Gmail with one new message waiting, plus Google's token endpoint. Answers by
 * URL so the test does not depend on the order the poll makes its calls in.
 */
const googleResponds = () => {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    void init;
    const url = new URL(String(input));

    if (url.hostname === "oauth2.googleapis.com") {
      return jsonResponse({ access_token: "access-2", expires_in: 3599 });
    }
    if (url.pathname.endsWith("/history")) {
      return jsonResponse({
        history: [
          {
            id: "1001",
            messagesAdded: [
              { message: { id: "msg-1", threadId: "thread-1", labelIds: ["INBOX"] } },
            ],
          },
        ],
        historyId: "1100",
      });
    }
    return jsonResponse({
      id: "msg-1",
      threadId: "thread-1",
      labelIds: ["INBOX"],
      snippet: "Bon dia,",
      internalDate: "1700000000000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "client@example.com" },
          { name: "To", value: "bustia@example.com" },
          { name: "Subject", value: "Pressupost" },
        ],
        body: { data: Buffer.from("Bon dia").toString("base64url") },
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Drizzle's proxy driver: statements are built for real and captured instead of
 * reaching Postgres, so the test asserts on what would actually be written.
 */
const recordingDatabase = ({
  account = true,
  expiresAt = new Date(Date.now() + HOUR_MS).toISOString() as string | null,
  refreshToken = "refresh-1" as string | null,
} = {}) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    if (!sql.startsWith("select")) return { rows: [] };
    if (!account) return { rows: [] };
    return {
      rows: [
        [
          MAILBOX_ID,
          TENANT_ID,
          "bustia@example.com",
          "1000",
          encryptToken("access-1", encryptionKey),
          refreshToken ? encryptToken(refreshToken, encryptionKey) : null,
          expiresAt,
        ],
      ],
    };
  });
  return { db, statements };
};

const poll = (db: ReturnType<typeof recordingDatabase>["db"]) =>
  pollGmailMailbox(
    db,
    { tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID },
    { credentials: CREDENTIALS, encryptionKey },
  );

const updates = (statements: { sql: string; params: unknown[] }[]) =>
  statements.filter(({ sql }) => sql.startsWith("update"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollGmailMailbox", () => {
  it("returns the mail that arrived since the stored cursor", async () => {
    const fetchMock = googleResponds();
    const { db } = recordingDatabase();

    const outcome = await poll(db);

    expect(outcome).toMatchObject({
      tenantId: TENANT_ID,
      mailboxAccountId: MAILBOX_ID,
      cursor: "1100",
      cursorReset: false,
    });
    expect(outcome!.messages).toHaveLength(1);
    expect(outcome!.messages[0]).toMatchObject({
      providerMessageId: "msg-1",
      providerThreadId: "thread-1",
      direction: "inbound",
      fromAddress: "client@example.com",
      subject: "Pressupost",
    });

    // Only new mail is polled (context.md §4): history resumes from the cursor.
    const history = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/history"),
    );
    expect(String(history![0])).toContain("startHistoryId=1000");
  });

  it("moves the cursor forward so the next poll does not repeat the mail", async () => {
    googleResponds();
    const { db, statements } = recordingDatabase();

    await poll(db);

    const [update] = updates(statements);
    expect(update!.sql).toContain('"mailbox_accounts"');
    expect(update!.sql).toContain('"sync_cursor"');
    expect(update!.sql).toContain('"last_polled_at"');
    expect(update!.params).toContain("1100");
    expect(update!.params).toContain(MAILBOX_ID);
  });

  it("refreshes an expired access token and stores it encrypted", async () => {
    const fetchMock = googleResponds();
    const { db, statements } = recordingDatabase({
      expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
    });

    await poll(db);

    const refresh = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("oauth2.googleapis.com"),
    );
    expect(refresh).toBeDefined();
    expect(
      new URLSearchParams(refresh![1]!.body as string).get("refresh_token"),
    ).toBe("refresh-1");

    // Gmail is then called with the fresh token, not the expired one.
    const gmail = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("gmail.googleapis.com"),
    );
    expect((gmail![1]!.headers as Record<string, string>).authorization).toBe(
      "Bearer access-2",
    );

    // No raw token reaches the database (context.md §7).
    const written = updates(statements).flatMap(({ params }) => params);
    expect(written).not.toContain("access-2");
    const envelope = written.find(
      (param): param is string =>
        typeof param === "string" && param.startsWith("v1:"),
    );
    expect(decryptToken(envelope!, encryptionKey)).toBe("access-2");
  });

  it("keeps using an access token that has not expired yet", async () => {
    const fetchMock = googleResponds();
    const { db } = recordingDatabase();

    await poll(db);

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("oauth2.googleapis.com"),
      ),
    ).toBe(false);
  });

  it("skips a mailbox that was disconnected after the job was queued", async () => {
    googleResponds();
    const { db, statements } = recordingDatabase({ account: false });

    await expect(poll(db)).resolves.toBeNull();
    expect(updates(statements)).toEqual([]);
  });

  it("refuses to poll a mailbox whose refresh token is gone", async () => {
    googleResponds();
    const { db } = recordingDatabase({
      refreshToken: null,
      expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
    });

    await expect(poll(db)).rejects.toThrow(/refresh token/i);
  });
});

describe("listGmailPollTargets", () => {
  it("lists only Gmail mailboxes the worker can still authenticate as", async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => {
      statements.push({ sql, params });
      return { rows: [[TENANT_ID, MAILBOX_ID]] };
    });

    await expect(listGmailPollTargets(db)).resolves.toEqual([
      { tenantId: TENANT_ID, mailboxAccountId: MAILBOX_ID },
    ]);

    const { sql, params } = statements[0]!;
    expect(sql).toContain('"mailbox_accounts"');
    expect(sql).toContain('"refresh_token_encrypted" is not null');
    expect(params).toContain("google");
  });
});
