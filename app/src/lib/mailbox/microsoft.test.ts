import { createHash, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";
import { decryptToken } from "@correu-agent/shared/token-encryption";
import { LOGIN_PATH } from "../auth/config";
import {
  MAILBOX_OAUTH_COOKIE,
  MICROSOFT_MAILBOX_CALLBACK_PATH,
  MICROSOFT_MAILBOX_CONNECT_PATH,
  createMicrosoftMailboxHandlers,
} from "./microsoft";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const MAILBOX_ID = "33333333-3333-3333-3333-333333333333";
const DIRECTORY_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const ENCRYPTION_KEY = randomBytes(32);

const ENV = {
  AUTH_MICROSOFT_ENTRA_ID_ID: "entra-client-id",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-client-secret",
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: `https://login.microsoftonline.com/${DIRECTORY_ID}/v2.0`,
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY.toString("base64"),
};

const SESSION = {
  user: { id: USER_ID, tenantId: TENANT_ID, email: "aleix@example.com" },
  expires: "2999-01-01T00:00:00.000Z",
} as Session;

const TOKEN_RESPONSE = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  scope:
    "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send",
};

const GRAPH_ME = { id: "graph-user-id", mail: "bustia@example.com" };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Answers both calls the callback makes: the token exchange and Graph `/me`. */
const stubFetch = (
  overrides: { token?: Response } = {},
): { fetch: typeof globalThis.fetch; calls: Request[] } => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    calls.push(request);
    if (request.url.includes("graph.microsoft.com/v1.0/me")) {
      return json(GRAPH_ME);
    }
    return overrides.token
      ? overrides.token.clone()
      : json(TOKEN_RESPONSE);
  };
  return { fetch, calls };
};

const createRecordingDb = () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [[MAILBOX_ID]] };
  });
  return { db, queries };
};

const handlersFor = (
  options: {
    session?: Session | null;
    fetch?: typeof globalThis.fetch;
    db?: ReturnType<typeof createRecordingDb>["db"];
    env?: Record<string, string | undefined>;
  } = {},
) =>
  createMicrosoftMailboxHandlers({
    auth: async () => ("session" in options ? options.session! : SESSION),
    db: options.db ?? createRecordingDb().db,
    env: options.env ?? ENV,
    fetch: options.fetch ?? stubFetch().fetch,
  });

/** Render terminates TLS at its proxy, so the public origin is only in the headers. */
const request = (path: string, cookie?: string): NextRequest =>
  new NextRequest(`http://10.0.0.7:3000${path}`, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "correu.example",
      ...(cookie ? { cookie } : {}),
    },
  });

const cookieOf = (response: Response): string => {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]!;
};

const challengeFor = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** Runs the connect leg and returns what the browser would carry into the callback. */
const startConnection = async (): Promise<{
  authorizeUrl: URL;
  cookie: string;
}> => {
  const response = await handlersFor().connect(
    request(MICROSOFT_MAILBOX_CONNECT_PATH),
  );
  return {
    authorizeUrl: new URL(response.headers.get("location")!),
    cookie: cookieOf(response),
  };
};

describe("microsoft mailbox connect", () => {
  it("sends an anonymous visitor to the login page", async () => {
    const response = await handlersFor({ session: null }).connect(
      request(MICROSOFT_MAILBOX_CONNECT_PATH),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://correu.example${LOGIN_PATH}`,
    );
  });

  it("redirects to Entra asking for the mail scopes, with the callback of the public origin", async () => {
    const { authorizeUrl } = await startConnection();

    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      `https://login.microsoftonline.com/${DIRECTORY_ID}/oauth2/v2.0/authorize`,
    );
    expect(authorizeUrl.searchParams.get("scope")).toContain(
      "https://graph.microsoft.com/Mail.Send",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `https://correu.example${MICROSOFT_MAILBOX_CALLBACK_PATH}`,
    );
  });

  it("takes the outermost host when a proxy chain appended its own", async () => {
    const chained = new NextRequest(
      `http://10.0.0.7:3000${MICROSOFT_MAILBOX_CONNECT_PATH}`,
      {
        headers: {
          "x-forwarded-proto": "https, http",
          "x-forwarded-host": "correu.example, 10.0.0.7:3000",
        },
      },
    );

    const response = await handlersFor().connect(chained);
    const authorizeUrl = new URL(response.headers.get("location")!);

    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `https://correu.example${MICROSOFT_MAILBOX_CALLBACK_PATH}`,
    );
  });

  it.each(["TOKEN_ENCRYPTION_KEY", "AUTH_MICROSOFT_ENTRA_ID_ID"])(
    "stops at the dashboard instead of asking for consent it cannot use when %s is unset",
    async (missing) => {
      const response = await handlersFor({
        env: { ...ENV, [missing]: undefined },
      }).connect(request(MICROSOFT_MAILBOX_CONNECT_PATH));

      expect(response.headers.get("location")).toBe(
        "https://correu.example/?bustia=error",
      );
    },
  );

  it("keeps the CSRF state and the PKCE verifier in an http-only cookie", async () => {
    const response = await handlersFor().connect(
      request(MICROSOFT_MAILBOX_CONNECT_PATH),
    );
    const authorizeUrl = new URL(response.headers.get("location")!);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const [state, verifier] = cookieOf(response)
      .slice(`${MAILBOX_OAUTH_COOKIE}=`.length)
      .split(".");

    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).toContain("secure");
    expect(authorizeUrl.searchParams.get("state")).toBe(state);
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe(
      challengeFor(verifier!),
    );
  });
});

describe("microsoft mailbox callback", () => {
  const callbackPath = (params: Record<string, string>): string =>
    `${MICROSOFT_MAILBOX_CALLBACK_PATH}?${new URLSearchParams(params)}`;

  it("stores the mailbox with its tokens encrypted and reports back to the dashboard", async () => {
    const { authorizeUrl, cookie } = await startConnection();
    const { fetch, calls } = stubFetch();
    const { db, queries } = createRecordingDb();

    const response = await handlersFor({ fetch, db }).callback(
      request(
        callbackPath({
          code: "auth-code",
          state: authorizeUrl.searchParams.get("state")!,
        }),
        cookie,
      ),
    );

    const exchange = Object.fromEntries(
      new URLSearchParams(await calls[0]!.text()),
    );
    expect(exchange).toMatchObject({
      code: "auth-code",
      client_secret: ENV.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      redirect_uri: `https://correu.example${MICROSOFT_MAILBOX_CALLBACK_PATH}`,
    });
    expect(challengeFor(exchange.code_verifier!)).toBe(
      authorizeUrl.searchParams.get("code_challenge"),
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('insert into "mailbox_accounts"');
    const params = queries[0]!.params as string[];
    expect(params).toContain(TENANT_ID);
    expect(params).toContain("microsoft");
    expect(params).toContain("bustia@example.com");
    expect(params).not.toContain("refresh-token");
    expect(
      params
        .filter((param) => typeof param === "string" && param.startsWith("v1:"))
        .map((envelope) => decryptToken(envelope, ENCRYPTION_KEY)),
    ).toContain("refresh-token");

    expect(response.headers.get("location")).toBe(
      "https://correu.example/?bustia=connectada",
    );
    // The one-shot state must not survive the exchange.
    expect(response.headers.get("set-cookie")).toContain(
      `${MAILBOX_OAUTH_COOKIE}=;`,
    );
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const { cookie } = await startConnection();
    const { db, queries } = createRecordingDb();

    const response = await handlersFor({ db }).callback(
      request(callbackPath({ code: "auth-code", state: "forged" }), cookie),
    );

    expect(response.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("refuses a callback with no stored state at all", async () => {
    const response = await handlersFor().callback(
      request(callbackPath({ code: "auth-code", state: "whatever" })),
    );

    expect(response.status).toBe(400);
  });

  it("sends an anonymous visitor to the login page", async () => {
    const { authorizeUrl, cookie } = await startConnection();

    const response = await handlersFor({ session: null }).callback(
      request(
        callbackPath({
          code: "auth-code",
          state: authorizeUrl.searchParams.get("state")!,
        }),
        cookie,
      ),
    );

    expect(response.headers.get("location")).toBe(
      `https://correu.example${LOGIN_PATH}`,
    );
  });

  it("reports a consent the user refused at Microsoft", async () => {
    const { authorizeUrl, cookie } = await startConnection();
    const { db, queries } = createRecordingDb();

    const response = await handlersFor({ db }).callback(
      request(
        callbackPath({
          error: "access_denied",
          state: authorizeUrl.searchParams.get("state")!,
        }),
        cookie,
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://correu.example/?bustia=error",
    );
    expect(queries).toHaveLength(0);
  });

  it("stores nothing when the token exchange fails", async () => {
    const { authorizeUrl, cookie } = await startConnection();
    const { fetch } = stubFetch({
      token: json({ error: "invalid_grant" }, 400),
    });
    const { db, queries } = createRecordingDb();

    const response = await handlersFor({ fetch, db }).callback(
      request(
        callbackPath({
          code: "auth-code",
          state: authorizeUrl.searchParams.get("state")!,
        }),
        cookie,
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://correu.example/?bustia=error",
    );
    expect(queries).toHaveLength(0);
  });
});
