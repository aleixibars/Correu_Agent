import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { decryptToken, encryptToken } from "@correu-agent/shared/token-encryption";
import { describe, expect, it } from "vitest";
import { loadMicrosoftPollConfig, pollMicrosoftMailbox } from "./microsoft";
import type { PollableMailboxAccount } from "./accounts";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const MAILBOX_ID = "22222222-2222-2222-2222-222222222222";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-01-01T09:00:00.000Z");

const account = (
  overrides: Partial<PollableMailboxAccount> = {},
): PollableMailboxAccount => ({
  id: MAILBOX_ID,
  tenantId: TENANT_ID,
  provider: "microsoft",
  emailAddress: "bustia@example.com",
  accessTokenEncrypted: encryptToken("stored-access-token", ENCRYPTION_KEY),
  refreshTokenEncrypted: encryptToken("stored-refresh-token", ENCRYPTION_KEY),
  tokenExpiresAt: new Date("2026-01-01T09:30:00.000Z"),
  syncCursor: "https://delta/1",
  connectedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const DELTA_PAGE = {
  value: [
    {
      id: "message-1",
      conversationId: "conversation-1",
      internetMessageId: "<message-1@example.com>",
      subject: "Pressupost",
      receivedDateTime: "2026-01-01T08:00:00Z",
      isDraft: false,
    },
  ],
  "@odata.deltaLink": "https://delta/2",
};

const TOKEN_RESPONSE = {
  access_token: "fresh-access-token",
  refresh_token: "fresh-refresh-token",
  expires_in: 3600,
  scope: "https://graph.microsoft.com/Mail.Read",
};

/** Drizzle's proxy driver runs the update as written, without a live Neon connection. */
const createRecordingDb = () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  });
  return { db, queries };
};

const stubFetch = (responses: unknown[]) => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input as RequestInfo, init));
    const body = responses[calls.length - 1];
    if (body === undefined) throw new Error(`Unexpected request #${calls.length}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
};

const config = (fetch: typeof globalThis.fetch) => ({
  clientId: "entra-client-id",
  clientSecret: "entra-client-secret",
  encryptionKey: ENCRYPTION_KEY,
  fetch,
  now: () => NOW,
});

describe("pollMicrosoftMailbox", () => {
  it("reads new mail from the stored cursor with the stored access token", async () => {
    const { db, queries } = createRecordingDb();
    const { fetch, calls } = stubFetch([DELTA_PAGE]);

    const messages = await pollMicrosoftMailbox(db, account(), config(fetch));

    // A token that is still valid is reused: refreshing on every poll would
    // mean 720 pointless token requests a day per mailbox (context.md §8).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://delta/1");
    expect(calls[0]!.headers.get("authorization")).toBe(
      "Bearer stored-access-token",
    );
    expect(messages).toEqual([
      {
        providerMessageId: "message-1",
        providerThreadId: "conversation-1",
        messageIdHeader: "<message-1@example.com>",
        subject: "Pressupost",
        receivedAt: new Date("2026-01-01T08:00:00Z"),
      },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('update "mailbox_accounts"');
    expect(queries[0]!.params).toContain("https://delta/2");
    // Timestamps reach the driver already serialised.
    expect(queries[0]!.params).toContain(NOW.toISOString());
  });

  it("scopes the cursor write to the mailbox's own tenant", async () => {
    const { db, queries } = createRecordingDb();
    const { fetch } = stubFetch([DELTA_PAGE]);

    await pollMicrosoftMailbox(db, account(), config(fetch));

    expect(queries[0]!.params).toContain(TENANT_ID);
    expect(queries[0]!.params).toContain(MAILBOX_ID);
  });

  it("refreshes an access token that is about to expire and stores it encrypted", async () => {
    const { db, queries } = createRecordingDb();
    const { fetch, calls } = stubFetch([TOKEN_RESPONSE, DELTA_PAGE]);

    await pollMicrosoftMailbox(
      db,
      // Inside the skew window: valid now, dead before the poll is over.
      account({ tokenExpiresAt: new Date(NOW.getTime() + 10_000) }),
      config(fetch),
    );

    expect(calls[0]!.url).toContain("/oauth2/v2.0/token");
    expect(calls[1]!.headers.get("authorization")).toBe(
      "Bearer fresh-access-token",
    );

    const params = queries[0]!.params as string[];
    expect(params).not.toContain("fresh-access-token");
    expect(params).not.toContain("fresh-refresh-token");
    const envelopes = params.filter(
      (param) => typeof param === "string" && param.startsWith("v1:"),
    );
    expect(
      envelopes.map((envelope) => decryptToken(envelope, ENCRYPTION_KEY)),
    ).toEqual(["fresh-access-token", "fresh-refresh-token"]);
  });

  it("refreshes when the mailbox has no access token stored at all", async () => {
    const { db } = createRecordingDb();
    const { fetch, calls } = stubFetch([TOKEN_RESPONSE, DELTA_PAGE]);

    await pollMicrosoftMailbox(
      db,
      account({ accessTokenEncrypted: null, tokenExpiresAt: null }),
      config(fetch),
    );

    expect(calls[0]!.url).toContain("/oauth2/v2.0/token");
  });

  it("starts an uncursored mailbox from the connection instant, not from its history", async () => {
    const { db } = createRecordingDb();
    const { fetch, calls } = stubFetch([
      { value: [], "@odata.deltaLink": "https://delta/2" },
      { value: [] },
    ]);

    await pollMicrosoftMailbox(db, account({ syncCursor: null }), config(fetch));

    expect(calls[0]!.url).toContain("deltatoken=latest");
    expect(decodeURIComponent(calls[1]!.url)).toContain(
      "receivedDateTime gt 2026-01-01T00:00:00.000Z",
    );
  });

  it("refuses a mailbox whose grant is gone instead of polling with nothing", async () => {
    const { db } = createRecordingDb();
    const { fetch } = stubFetch([]);

    await expect(
      pollMicrosoftMailbox(
        db,
        account({ refreshTokenEncrypted: null }),
        config(fetch),
      ),
    ).rejects.toThrow(/reconnect|refresh token/i);
  });
});

describe("loadMicrosoftPollConfig", () => {
  const ENV = {
    AUTH_MICROSOFT_ENTRA_ID_ID: "entra-client-id",
    AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-client-secret",
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY.toString("base64"),
  };

  it("reuses the app's Entra credentials and pins the configured directory", () => {
    const config = loadMicrosoftPollConfig({
      ...ENV,
      AUTH_MICROSOFT_ENTRA_ID_ISSUER:
        "https://login.microsoftonline.com/directory-id/v2.0",
    });

    expect(config).toMatchObject({
      clientId: "entra-client-id",
      clientSecret: "entra-client-secret",
      tenant: "directory-id",
    });
    expect(config.encryptionKey.equals(ENCRYPTION_KEY)).toBe(true);
  });

  it("names the variable that is missing", () => {
    expect(() =>
      loadMicrosoftPollConfig({ ...ENV, AUTH_MICROSOFT_ENTRA_ID_SECRET: "" }),
    ).toThrow(/AUTH_MICROSOFT_ENTRA_ID_SECRET/);
  });
});
