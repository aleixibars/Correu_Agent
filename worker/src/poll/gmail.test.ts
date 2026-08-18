import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptToken,
  encryptToken,
} from "@correu-agent/shared/token-encryption";
import type { PollableMailboxAccount } from "./accounts";
import { pollGmailMailbox } from "./gmail";

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
          { name: "Message-ID", value: "<msg-1@example.com>" },
        ],
        body: { data: Buffer.from("Bon dia").toString("base64url") },
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const HOUR_MS = 60 * 60 * 1000;

const account = ({
  expiresAt = new Date(Date.now() + HOUR_MS) as Date | null,
  refreshToken = "refresh-1" as string | null,
  syncCursor = "1000" as string | null,
} = {}): PollableMailboxAccount => ({
  id: MAILBOX_ID,
  tenantId: TENANT_ID,
  provider: "google",
  emailAddress: "bustia@example.com",
  accessTokenEncrypted: encryptToken("access-1", encryptionKey),
  refreshTokenEncrypted: refreshToken
    ? encryptToken(refreshToken, encryptionKey)
    : null,
  tokenExpiresAt: expiresAt,
  syncCursor,
  connectedAt: new Date("2026-01-01T00:00:00.000Z"),
});

/**
 * Drizzle's proxy driver: statements are built for real and captured instead of
 * reaching Postgres, so the test asserts on what would actually be written.
 */
const recordingDatabase = () => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    return { rows: [] };
  });
  return { db, statements };
};

const updates = (statements: { sql: string; params: unknown[] }[]) =>
  statements.filter(({ sql }) => sql.startsWith("update"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollGmailMailbox", () => {
  it("returns the mail that arrived since the stored cursor", async () => {
    const fetchMock = googleResponds();
    const { db } = recordingDatabase();

    const messages = await pollGmailMailbox(db, account(), {
      credentials: CREDENTIALS,
      encryptionKey,
    });

    expect(messages).toHaveLength(1);
    // The whole message, body included: it is stored as it arrives and never
    // fetched from Gmail a second time (context.md §7).
    expect(messages[0]).toMatchObject({
      providerMessageId: "msg-1",
      providerThreadId: "thread-1",
      direction: "inbound",
      messageIdHeader: "<msg-1@example.com>",
      fromAddress: "client@example.com",
      toAddresses: ["bustia@example.com"],
      subject: "Pressupost",
      bodyText: "Bon dia",
      sentAt: new Date(1700000000000),
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

    await pollGmailMailbox(db, account(), {
      credentials: CREDENTIALS,
      encryptionKey,
    });

    const [update] = updates(statements);
    expect(update!.sql).toContain('"mailbox_accounts"');
    expect(update!.sql).toContain('"sync_cursor"');
    expect(update!.sql).toContain('"last_polled_at"');
    expect(update!.params).toContain("1100");
    expect(update!.params).toContain(MAILBOX_ID);
    // Tenant-scoped like every other write of a mailbox row.
    expect(update!.params).toContain(TENANT_ID);
  });

  it("refreshes an expired access token and stores it encrypted", async () => {
    const fetchMock = googleResponds();
    const { db, statements } = recordingDatabase();

    await pollGmailMailbox(
      db,
      account({ expiresAt: new Date(Date.now() - HOUR_MS) }),
      { credentials: CREDENTIALS, encryptionKey },
    );

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

    await pollGmailMailbox(db, account(), {
      credentials: CREDENTIALS,
      encryptionKey,
    });

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("oauth2.googleapis.com"),
      ),
    ).toBe(false);
  });

  it("refuses to poll a mailbox whose refresh token is gone", async () => {
    googleResponds();
    const { db } = recordingDatabase();

    await expect(
      pollGmailMailbox(
        db,
        account({
          refreshToken: null,
          expiresAt: new Date(Date.now() - HOUR_MS),
        }),
        { credentials: CREDENTIALS, encryptionKey },
      ),
    ).rejects.toThrow(/refresh token/i);
  });

  it("warns when a mailbox lost its Gmail history window", async () => {
    // Gmail keeps history for about a week; past that the skipped mail is not
    // recoverable (context.md §4), so it has to be visible.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/history")) {
          return jsonResponse({ error: { message: "Not Found" } }, 404);
        }
        return jsonResponse({ historyId: "9000" });
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = recordingDatabase();

    const messages = await pollGmailMailbox(db, account(), {
      credentials: CREDENTIALS,
      encryptionKey,
    });

    expect(messages).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("bustia@example.com"),
    );
    warn.mockRestore();
  });

  it("starts a mailbox with no cursor from now, without warning about it", async () => {
    // Nothing was lost — the backlog is deliberately not imported (context.md §4).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ historyId: "9000" })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, statements } = recordingDatabase();

    const messages = await pollGmailMailbox(db, account({ syncCursor: null }), {
      credentials: CREDENTIALS,
      encryptionKey,
    });

    expect(messages).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(updates(statements)[0]!.params).toContain("9000");
    warn.mockRestore();
  });
});
