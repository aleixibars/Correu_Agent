import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptToken } from "@correu-agent/shared/token-encryption";
import { GOOGLE_MAILBOX_SCOPES } from "./google-oauth";
import {
  MailboxConnectionError,
  connectGoogleMailbox,
} from "./connect-google-mailbox";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const MAILBOX_ID = "33333333-3333-3333-3333-333333333333";

const CLIENT = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://correu.example/api/mailbox/google/callback",
};

const encryptionKey = randomBytes(32);

const idToken = (payload: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const googleResponds = ({
  scope = GOOGLE_MAILBOX_SCOPES.join(" "),
  refreshToken = "refresh-1" as string | null,
} = {}) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        access_token: "access-1",
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        expires_in: 3599,
        scope,
        id_token: idToken({ sub: "google-sub-1" }),
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({ emailAddress: "bustia@example.com", historyId: "98765" }),
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/**
 * Drizzle's proxy driver: the statements the connect flow issues are built for
 * real and captured here instead of reaching Postgres, so the test asserts on
 * what would actually be written.
 */
const recordingDatabase = () => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    // Shape of `.returning({ id })`: one row, one column.
    return { rows: [[MAILBOX_ID]] };
  });
  return { db, statements };
};

const connect = (db: ReturnType<typeof recordingDatabase>["db"]) =>
  connectGoogleMailbox(db, {
    tenantId: TENANT_ID,
    userId: USER_ID,
    code: "code-1",
    codeVerifier: "verifier-1",
    client: CLIENT,
    encryptionKey,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectGoogleMailbox", () => {
  it("saves the mailbox for the tenant with the tokens encrypted", async () => {
    googleResponds();
    const { db, statements } = recordingDatabase();

    await expect(connect(db)).resolves.toEqual({
      id: MAILBOX_ID,
      emailAddress: "bustia@example.com",
    });

    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0]!;
    expect(sql).toContain('"mailbox_accounts"');
    expect(params).toContain(TENANT_ID);
    expect(params).toContain(USER_ID);
    expect(params).toContain("google");
    expect(params).toContain("bustia@example.com");
    expect(params).toContain("google-sub-1");
    // Only new mail is processed (context.md §4): polling resumes from the
    // history cursor as it stood when the mailbox was connected.
    expect(params).toContain("98765");

    // No raw token reaches the database (context.md §7).
    expect(params).not.toContain("access-1");
    expect(params).not.toContain("refresh-1");
    const envelopes = params.filter(
      (param): param is string =>
        typeof param === "string" && param.startsWith("v1:"),
    );
    expect(
      envelopes.map((envelope) => decryptToken(envelope, encryptionKey)),
    ).toEqual(["access-1", "refresh-1"]);
  });

  it("keeps the stored refresh token when Google re-consents without one", async () => {
    googleResponds({ refreshToken: null });
    const { db, statements } = recordingDatabase();

    await connect(db);

    const { sql, params } = statements[0]!;
    const envelopes = params.filter(
      (param): param is string =>
        typeof param === "string" && param.startsWith("v1:"),
    );
    expect(
      envelopes.map((envelope) => decryptToken(envelope, encryptionKey)),
    ).toEqual(["access-1"]);
    // Nothing is written for the refresh token, so on a reconnect the stored
    // one has to survive the upsert — otherwise the worker loses the only
    // credential it can poll with once the access token expires.
    expect(sql).toContain(
      '"refresh_token_encrypted" = coalesce(excluded.refresh_token_encrypted, "mailbox_accounts"."refresh_token_encrypted")',
    );
  });

  it("leaves the sync cursor alone when the same mailbox is reconnected", async () => {
    googleResponds();
    const { db, statements } = recordingDatabase();

    await connect(db);

    // Moving the cursor forward on a reconnect would skip every mail that
    // arrived while the mailbox was disconnected (context.md §4).
    const { sql } = statements[0]!;
    const conflictClause = sql.slice(sql.indexOf("do update set"));
    expect(conflictClause).not.toBe("");
    expect(conflictClause).not.toContain("sync_cursor");
    expect(conflictClause).not.toContain("connected_at");
  });

  it("refuses a consent screen where the user unticked the send grant", async () => {
    googleResponds({
      scope: "openid https://www.googleapis.com/auth/gmail.readonly",
    });
    const { db, statements } = recordingDatabase();

    await expect(connect(db)).rejects.toMatchObject({
      code: "scopes_refused",
    });
    // A half-granted mailbox is worse than none: it would poll fine and then
    // fail at the first send.
    expect(statements).toHaveLength(0);
  });

  it("refuses a token response with no account id to key the mailbox on", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3599,
            scope: GOOGLE_MAILBOX_SCOPES.join(" "),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ emailAddress: "bustia@example.com", historyId: "98765" }),
        ),
    );
    const { db, statements } = recordingDatabase();

    await expect(connect(db)).rejects.toMatchObject({ code: "oauth_failed" });
    expect(statements).toHaveLength(0);
  });

  it("reports a failed exchange as a connection error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400)),
    );
    const { db, statements } = recordingDatabase();

    const error = await connect(db).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MailboxConnectionError);
    expect(error).toMatchObject({ code: "oauth_failed" });
    expect(statements).toHaveLength(0);
  });
});
