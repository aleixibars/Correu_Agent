import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GMAIL_PROFILE_ENDPOINT,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_MAILBOX_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  buildGoogleAuthorizationUrl,
  createGoogleAuthorizationRequest,
  encodeMailboxOAuthCookie,
  exchangeGoogleAuthorizationCode,
  fetchGmailProfile,
  googleAccountIdFromIdToken,
  loadGoogleOAuthClient,
  resolveGoogleCallbackUrl,
  verifyMailboxOAuthCookie,
} from "./google-oauth";

const CLIENT = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://correu.example/api/mailbox/google/callback",
};

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

const stubFetch = (...responses: Response[]) => {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("buildGoogleAuthorizationUrl", () => {
  const params = (): URLSearchParams =>
    new URL(buildGoogleAuthorizationUrl(CLIENT, "state-1", "verifier-1"))
      .searchParams;

  it("asks Google for the Gmail read and send grants", () => {
    expect(
      buildGoogleAuthorizationUrl(CLIENT, "state-1", "verifier-1").startsWith(
        GOOGLE_AUTHORIZATION_ENDPOINT,
      ),
    ).toBe(true);
    expect(params().get("scope")?.split(" ")).toEqual([
      ...GOOGLE_MAILBOX_SCOPES,
    ]);
    expect(GOOGLE_MAILBOX_SCOPES).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(GOOGLE_MAILBOX_SCOPES).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("asks for a refresh token, since the worker polls without the user present", () => {
    expect(params().get("access_type")).toBe("offline");
    // Google only re-issues a refresh token when consent is asked for again.
    expect(params().get("prompt")).toBe("consent");
  });

  it("sends the state and the S256 challenge derived from the verifier", () => {
    expect(params().get("state")).toBe("state-1");
    expect(params().get("code_challenge_method")).toBe("S256");
    expect(params().get("code_challenge")).toBe(
      createHash("sha256").update("verifier-1").digest("base64url"),
    );
    expect(params().get("code_challenge")).not.toBe("verifier-1");
  });

  it("carries the client and the callback it will come back to", () => {
    expect(params().get("client_id")).toBe(CLIENT.clientId);
    expect(params().get("redirect_uri")).toBe(CLIENT.redirectUri);
    expect(params().get("response_type")).toBe("code");
  });
});

describe("createGoogleAuthorizationRequest", () => {
  it("mints a fresh state and verifier per attempt", () => {
    const first = createGoogleAuthorizationRequest(CLIENT);
    const second = createGoogleAuthorizationRequest(CLIENT);

    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.url).toContain(encodeURIComponent(first.state));
  });
});

describe("mailbox OAuth cookie", () => {
  it("returns the verifier when the callback state matches the cookie", () => {
    const { state, codeVerifier } = createGoogleAuthorizationRequest(CLIENT);

    expect(
      verifyMailboxOAuthCookie(
        encodeMailboxOAuthCookie({ state, codeVerifier }),
        state,
      ),
    ).toBe(codeVerifier);
  });

  it("refuses a callback whose state does not match the cookie", () => {
    const { state, codeVerifier } = createGoogleAuthorizationRequest(CLIENT);
    const cookie = encodeMailboxOAuthCookie({ state, codeVerifier });

    // A forged callback is the whole reason the state exists: without this the
    // attacker's mailbox would be connected to the victim's tenant.
    expect(verifyMailboxOAuthCookie(cookie, "another-state")).toBeNull();
    expect(verifyMailboxOAuthCookie(cookie, null)).toBeNull();
    expect(verifyMailboxOAuthCookie(undefined, state)).toBeNull();
    expect(verifyMailboxOAuthCookie("", state)).toBeNull();
  });
});

describe("exchangeGoogleAuthorizationCode", () => {
  it("posts the code, the verifier and the client credentials to Google", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T10:00:00.000Z"));
    const fetchMock = stubFetch(
      jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3599,
        scope: GOOGLE_MAILBOX_SCOPES.join(" "),
        id_token: idToken({ sub: "google-sub-1" }),
      }),
    );

    const tokens = await exchangeGoogleAuthorizationCode(CLIENT, {
      code: "code-1",
      codeVerifier: "verifier-1",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "verifier-1",
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      redirect_uri: CLIENT.redirectUri,
    });
    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date("2026-08-18T10:59:59.000Z"),
      scopes: [...GOOGLE_MAILBOX_SCOPES],
    });
  });

  it("reports no refresh token rather than inventing one", async () => {
    stubFetch(
      jsonResponse({ access_token: "access-1", expires_in: 3599, scope: "" }),
    );

    const tokens = await exchangeGoogleAuthorizationCode(CLIENT, {
      code: "code-1",
      codeVerifier: "verifier-1",
    });

    expect(tokens.refreshToken).toBeNull();
    expect(tokens.idToken).toBeNull();
  });

  it("fails loudly when Google rejects the exchange", async () => {
    stubFetch(jsonResponse({ error: "invalid_grant" }, 400));

    await expect(
      exchangeGoogleAuthorizationCode(CLIENT, {
        code: "used-code",
        codeVerifier: "verifier-1",
      }),
    ).rejects.toThrow("invalid_grant");
  });

  it("fails when the response carries no access token", async () => {
    stubFetch(jsonResponse({ expires_in: 3599 }));

    await expect(
      exchangeGoogleAuthorizationCode(CLIENT, {
        code: "code-1",
        codeVerifier: "verifier-1",
      }),
    ).rejects.toThrow(/access token/i);
  });
});

describe("fetchGmailProfile", () => {
  it("returns the mailbox address and the history cursor to resume polling from", async () => {
    const fetchMock = stubFetch(
      jsonResponse({ emailAddress: "bustia@example.com", historyId: "98765" }),
    );

    await expect(fetchGmailProfile("access-1")).resolves.toEqual({
      emailAddress: "bustia@example.com",
      historyId: "98765",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GMAIL_PROFILE_ENDPOINT);
    expect(init.headers).toMatchObject({ authorization: "Bearer access-1" });
  });

  it("accepts a numeric historyId, which the API reference types as a uint64", async () => {
    stubFetch(
      jsonResponse({ emailAddress: "bustia@example.com", historyId: 98765 }),
    );

    await expect(fetchGmailProfile("access-1")).resolves.toMatchObject({
      historyId: "98765",
    });
  });

  it("refuses a profile with no historyId instead of an empty cursor", async () => {
    // An empty cursor is not "start from now": the worker cannot resume from it,
    // and only mail newer than the connection is ever processed (context.md §4).
    stubFetch(jsonResponse({ emailAddress: "bustia@example.com" }));

    await expect(fetchGmailProfile("access-1")).rejects.toThrow(/historyId/);
  });

  it("fails loudly when Gmail refuses the token", async () => {
    stubFetch(jsonResponse({ error: { message: "Invalid Credentials" } }, 401));

    await expect(fetchGmailProfile("access-1")).rejects.toThrow(
      "Invalid Credentials",
    );
  });
});

describe("googleAccountIdFromIdToken", () => {
  it("reads the stable subject, which survives an address change", () => {
    expect(
      googleAccountIdFromIdToken(
        idToken({ sub: "google-sub-1", email: "bustia@example.com" }),
      ),
    ).toBe("google-sub-1");
  });

  it("rejects a token with no subject", () => {
    expect(() => googleAccountIdFromIdToken(idToken({ email: "a@b.c" }))).toThrow();
    expect(() => googleAccountIdFromIdToken("not-a-jwt")).toThrow();
  });
});

describe("loadGoogleOAuthClient", () => {
  it("reuses the dashboard login's Google app (context.md §9)", () => {
    expect(
      loadGoogleOAuthClient(
        { AUTH_GOOGLE_ID: "id-1", AUTH_GOOGLE_SECRET: "secret-1" },
        CLIENT.redirectUri,
      ),
    ).toEqual({
      clientId: "id-1",
      clientSecret: "secret-1",
      redirectUri: CLIENT.redirectUri,
    });
  });

  it("throws when the Google credentials are missing", () => {
    expect(() => loadGoogleOAuthClient({}, CLIENT.redirectUri)).toThrow(
      /AUTH_GOOGLE_ID/,
    );
  });
});

describe("resolveGoogleCallbackUrl", () => {
  const request = new Request("http://10.0.0.7:10000/api/mailbox/google/connect");

  it("prefers the configured public URL, since Render terminates TLS at a proxy", () => {
    // Google matches the redirect URI exactly against the registered one, so the
    // internal origin the request arrives on would be rejected.
    expect(
      resolveGoogleCallbackUrl(request, { AUTH_URL: "https://correu.example" }),
    ).toBe(CLIENT.redirectUri);
  });

  it("falls back to the request origin when no public URL is configured", () => {
    expect(resolveGoogleCallbackUrl(request, {})).toBe(
      "http://10.0.0.7:10000/api/mailbox/google/callback",
    );
  });
});
