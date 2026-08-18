import { describe, expect, it } from "vitest";
import {
  MICROSOFT_MAILBOX_SCOPES,
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftAuthorizationCode,
  fetchMicrosoftMailboxIdentity,
  microsoftTenantFromIssuer,
} from "./microsoft";

const AUTHORIZATION_REQUEST = {
  clientId: "entra-client-id",
  redirectUri: "https://correu.example/api/mailboxes/microsoft/callback",
  state: "state-value",
  codeChallenge: "challenge-value",
};

const EXCHANGE_REQUEST = {
  ...AUTHORIZATION_REQUEST,
  clientSecret: "entra-client-secret",
  code: "auth-code",
  codeVerifier: "verifier-value",
};

const TOKEN_RESPONSE = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  scope:
    "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
};

/** Records the request the client makes and replies with a canned response. */
const stubFetch = (
  response: { status?: number; body: unknown },
): { fetch: typeof globalThis.fetch; calls: Request[] } => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input as RequestInfo, init));
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
};

describe("MICROSOFT_MAILBOX_SCOPES", () => {
  it("asks for reading and sending mail plus a refresh token", () => {
    expect(MICROSOFT_MAILBOX_SCOPES).toContain(
      "https://graph.microsoft.com/Mail.Read",
    );
    expect(MICROSOFT_MAILBOX_SCOPES).toContain(
      "https://graph.microsoft.com/Mail.Send",
    );
    // Without it Entra returns no refresh token and the 2-minute poll dies at
    // the first access-token expiry (context.md §8).
    expect(MICROSOFT_MAILBOX_SCOPES).toContain("offline_access");
  });
});

describe("microsoftTenantFromIssuer", () => {
  it("takes the directory out of a configured issuer", () => {
    expect(
      microsoftTenantFromIssuer(
        "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
      ),
    ).toBe("9188040d-6c67-4c5b-b112-36a304b66dad");
  });

  it("falls back to the multi-directory endpoint when unset", () => {
    expect(microsoftTenantFromIssuer(undefined)).toBe("common");
    expect(microsoftTenantFromIssuer("  ")).toBe("common");
  });
});

describe("buildMicrosoftAuthorizationUrl", () => {
  it("builds an authorization-code request with PKCE for the given directory", () => {
    const url = new URL(
      buildMicrosoftAuthorizationUrl({
        ...AUTHORIZATION_REQUEST,
        tenant: "directory-id",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/directory-id/oauth2/v2.0/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: AUTHORIZATION_REQUEST.clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: AUTHORIZATION_REQUEST.redirectUri,
      state: AUTHORIZATION_REQUEST.state,
      code_challenge: AUTHORIZATION_REQUEST.codeChallenge,
      code_challenge_method: "S256",
      scope: MICROSOFT_MAILBOX_SCOPES.join(" "),
    });
  });

  it("defaults to the multi-directory endpoint", () => {
    expect(buildMicrosoftAuthorizationUrl(AUTHORIZATION_REQUEST)).toContain(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
  });
});

describe("exchangeMicrosoftAuthorizationCode", () => {
  it("posts the code, the secret and the PKCE verifier to the token endpoint", async () => {
    const { fetch, calls } = stubFetch({ body: TOKEN_RESPONSE });

    const tokens = await exchangeMicrosoftAuthorizationCode({
      ...EXCHANGE_REQUEST,
      tenant: "directory-id",
      now: new Date("2026-01-01T00:00:00.000Z"),
      fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://login.microsoftonline.com/directory-id/oauth2/v2.0/token",
    );
    expect(
      Object.fromEntries(new URLSearchParams(await calls[0]!.text())),
    ).toEqual({
      client_id: EXCHANGE_REQUEST.clientId,
      client_secret: EXCHANGE_REQUEST.clientSecret,
      grant_type: "authorization_code",
      code: EXCHANGE_REQUEST.code,
      code_verifier: EXCHANGE_REQUEST.codeVerifier,
      redirect_uri: EXCHANGE_REQUEST.redirectUri,
      scope: MICROSOFT_MAILBOX_SCOPES.join(" "),
    });
    expect(tokens).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
      scopes: [
        "https://graph.microsoft.com/Mail.Read",
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/User.Read",
      ],
    });
  });

  it("reports the error Entra sent back", async () => {
    const { fetch } = stubFetch({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "AADSTS70008: expired code",
      },
    });

    await expect(
      exchangeMicrosoftAuthorizationCode({ ...EXCHANGE_REQUEST, fetch }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("rejects a consent that left out a mail scope", async () => {
    const { fetch } = stubFetch({
      body: {
        ...TOKEN_RESPONSE,
        scope: "https://graph.microsoft.com/Mail.Read",
      },
    });

    await expect(
      exchangeMicrosoftAuthorizationCode({ ...EXCHANGE_REQUEST, fetch }),
    ).rejects.toThrow(/Mail.Send/);
  });

  it("rejects a grant with no refresh token, which cannot be polled later", async () => {
    const { fetch } = stubFetch({
      body: { ...TOKEN_RESPONSE, refresh_token: undefined },
    });

    await expect(
      exchangeMicrosoftAuthorizationCode({ ...EXCHANGE_REQUEST, fetch }),
    ).rejects.toThrow(/refresh token/i);
  });
});

describe("fetchMicrosoftMailboxIdentity", () => {
  it("reads the mailbox address and the account id from Graph", async () => {
    const { fetch, calls } = stubFetch({
      body: {
        id: "graph-user-id",
        mail: "Bustia@Example.com",
        userPrincipalName: "bustia_example.com#EXT#@example.onmicrosoft.com",
      },
    });

    const identity = await fetchMicrosoftMailboxIdentity({
      accessToken: "access-token",
      fetch,
    });

    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer access-token");
    // Stored lowercase: the mailbox is unique per (tenant, provider, address).
    expect(identity).toEqual({
      emailAddress: "bustia@example.com",
      providerAccountId: "graph-user-id",
    });
  });

  it("falls back to the principal name when the account has no `mail`", async () => {
    const { fetch } = stubFetch({
      body: { id: "graph-user-id", mail: null, userPrincipalName: "a@b.com" },
    });

    await expect(
      fetchMicrosoftMailboxIdentity({ accessToken: "t", fetch }),
    ).resolves.toMatchObject({ emailAddress: "a@b.com" });
  });

  it("fails when Graph returns no usable address", async () => {
    const { fetch } = stubFetch({ body: { id: "graph-user-id" } });

    await expect(
      fetchMicrosoftMailboxIdentity({ accessToken: "t", fetch }),
    ).rejects.toThrow(/address/i);
  });
});
