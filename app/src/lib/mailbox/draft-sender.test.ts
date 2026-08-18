// The mail client an approved draft leaves through, built from the mailbox the
// draft's thread belongs to: the stored token while it lasts, a refreshed one after
// that, and the provider's own sender either way.

import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "@correu-agent/shared/token-encryption";
import { createDraftSender } from "./draft-sender";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const DRAFT_ID = "77777777-7777-7777-7777-777777777777";
const ACCOUNT_ID = "33333333-3333-3333-3333-333333333333";

const KEY = Buffer.alloc(32, 7);

const ENV = {
  TOKEN_ENCRYPTION_KEY: KEY.toString("base64"),
  AUTH_GOOGLE_ID: "google-client-id",
  AUTH_GOOGLE_SECRET: "google-client-secret",
  AUTH_MICROSOFT_ENTRA_ID_ID: "entra-client-id",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-client-secret",
};

const NOW = new Date("2026-08-18T10:00:00.000Z");

/** Drizzle's proxy driver: statements are built for real and captured. */
const recordingDatabase = (results: unknown[][][]) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    return { rows: results[statements.length - 1] ?? [] };
  });
  return { db, statements };
};

/** In the column order the mailbox select asks for. */
const accountRow = ({
  provider = "google",
  accessToken = "stored-access-token" as string | null,
  refreshToken = "stored-refresh-token" as string | null,
  expiresAt = "2026-08-18 11:00:00+00" as string | null,
}: {
  provider?: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
} = {}): unknown[] => [
  ACCOUNT_ID,
  provider,
  "bustia@example.com",
  accessToken === null ? null : encryptToken(accessToken, KEY),
  refreshToken === null ? null : encryptToken(refreshToken, KEY),
  expiresAt,
];

const REPLY = {
  fromAddress: "bustia@example.com",
  toAddresses: ["client@example.com"],
  ccAddresses: [],
  subject: "Re: Pressupost",
  bodyText: "Bon dia, us el passem avui.",
  providerThreadId: "gmail-thread-1",
  inReplyToProviderMessageId: "gmail-message-1",
  inReplyTo: "<one@example.com>",
  references: "<one@example.com>",
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const globalFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  globalFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type RecordingDatabase = ReturnType<typeof recordingDatabase>["db"];

const sender = (db: RecordingDatabase) =>
  createDraftSender(db, { tenantId: TENANT_ID, draftId: DRAFT_ID }, {
    env: ENV,
    now: () => NOW,
  });

describe("createDraftSender", () => {
  it("reads the mailbox of the draft's thread, for its tenant alone", async () => {
    const { db, statements } = recordingDatabase([[accountRow()]]);

    await sender(db);

    const { sql, params } = statements[0]!;
    expect(sql).toContain('from "drafts"');
    expect(sql).toContain('"threads"');
    expect(sql).toContain('"mailbox_accounts"');
    expect(sql).toContain('"drafts"."tenant_id" = ');
    expect(params).toContain(TENANT_ID);
    expect(params).toContain(DRAFT_ID);
  });

  // A draft id arrives on a form: another tenant's draft must not resolve to a
  // client that could send mail out of that tenant's mailbox.
  it("refuses a draft the tenant does not have", async () => {
    const { db } = recordingDatabase([[]]);

    await expect(sender(db)).rejects.toThrow(DRAFT_ID);
  });

  it("sends through Gmail with the stored token while it is still valid", async () => {
    const { db, statements } = recordingDatabase([[accountRow()]]);
    globalFetch.mockResolvedValue(jsonResponse({ id: "gmail-sent-1" }));

    const sent = await (await sender(db)).sendReply(REPLY);

    expect(sent.providerMessageId).toBe("gmail-sent-1");
    // Only the mailbox read: a token still good for an hour is not renewed.
    expect(statements).toHaveLength(1);
    const [url, init] = globalFetch.mock.calls[0]!;
    expect(String(url)).toContain("gmail.googleapis.com");
    expect(
      new Headers(init?.headers).get("authorization"),
    ).toBe("Bearer stored-access-token");
  });

  it("renews an expired Google token and stores it encrypted", async () => {
    const { db, statements } = recordingDatabase([[
      accountRow({ expiresAt: "2026-08-18 09:00:00+00" }),
    ]]);
    globalFetch
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "fresh-access-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "gmail-sent-2" }));

    await (await sender(db)).sendReply(REPLY);

    expect(String(globalFetch.mock.calls[0]![0])).toContain(
      "oauth2.googleapis.com",
    );
    const write = statements[1]!;
    expect(write.sql).toContain('update "mailbox_accounts"');
    expect(write.params).toContain(ACCOUNT_ID);
    // Encrypted at the application layer (context.md §7): the token itself
    // never reaches a statement.
    expect(write.params).not.toContain("fresh-access-token");
    expect(
      new Headers(globalFetch.mock.calls[1]![1]?.headers).get("authorization"),
    ).toBe("Bearer fresh-access-token");
  });

  // A token that dies mid-send is as good as expired, and a send that fails
  // halfway is the one failure the product cannot retry safely.
  it("renews a token that expires within the minute", async () => {
    const { db } = recordingDatabase([[
      accountRow({ expiresAt: "2026-08-18 10:00:30+00" }),
    ]]);
    globalFetch
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "fresh-access-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "gmail-sent-3" }));

    await (await sender(db)).sendReply(REPLY);

    expect(String(globalFetch.mock.calls[0]![0])).toContain(
      "oauth2.googleapis.com",
    );
  });

  it("refuses a mailbox whose grant is gone", async () => {
    const { db } = recordingDatabase([[
      accountRow({ accessToken: null, refreshToken: null, expiresAt: null }),
    ]]);

    await expect(sender(db)).rejects.toThrow("bustia@example.com");
  });

  it("sends through Microsoft Graph for a Microsoft mailbox", async () => {
    const { db } = recordingDatabase([[accountRow({ provider: "microsoft" })]]);
    globalFetch
      .mockResolvedValueOnce(jsonResponse({ id: "graph-draft-1" }))
      .mockResolvedValueOnce(new Response("", { status: 202 }));

    const sent = await (await sender(db)).sendReply(REPLY);

    expect(String(globalFetch.mock.calls[0]![0])).toContain(
      "graph.microsoft.com",
    );
    expect(sent.providerMessageId).toBe("graph-draft-1");
  });

  // Entra rotates the refresh token away on use: storing only the access token
  // would lock the mailbox out at the next send.
  it("stores the rotated refresh token of a renewed Microsoft mailbox", async () => {
    const { db, statements } = recordingDatabase([[
      accountRow({
        provider: "microsoft",
        expiresAt: "2026-08-18 09:00:00+00",
      }),
    ]]);
    globalFetch
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "fresh-graph-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "graph-draft-2" }))
      .mockResolvedValueOnce(new Response("", { status: 202 }));

    await (await sender(db)).sendReply(REPLY);

    const write = statements[1]!;
    expect(write.sql).toContain('update "mailbox_accounts"');
    expect(write.params).not.toContain("rotated-refresh-token");
    expect(write.params).not.toContain("fresh-graph-token");
    // Both columns are written, so neither the access nor the refresh token is
    // left pointing at the grant Entra has already retired.
    expect(write.sql).toContain('"refresh_token_encrypted"');
    expect(write.sql).toContain('"access_token_encrypted"');
  });
});
