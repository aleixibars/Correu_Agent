// Microsoft Graph side of connecting a mailbox (context.md §9). Only the OAuth
// authorization-code flow and the identity lookup live here; reading and
// sending mail arrive with the polling and send issues, behind this same typed
// client so Gmail and Graph stay swappable.

const AUTHORITY = "https://login.microsoftonline.com";
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** Endpoint that accepts every Azure directory, used when no issuer is pinned. */
const MULTI_DIRECTORY_TENANT = "common";

/**
 * `offline_access` is what makes Entra return a refresh token, without which
 * the mailbox stops being pollable an hour after it is connected.
 */
export const MICROSOFT_MAILBOX_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
] as const;

/** Scopes the product cannot work without, checked against what was consented. */
const REQUIRED_GRAPH_SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
] as const;

const SCOPE_PARAM = MICROSOFT_MAILBOX_SCOPES.join(" ");

/**
 * Entra is not consistent about how it spells a granted scope back at us: the
 * fully qualified `https://graph.microsoft.com/Mail.Read`, the bare
 * `Mail.Read`, a lowercased variant, and (per Microsoft's own token-response
 * docs) a percent-encoded URI are all shapes seen in the wild. Comparing the
 * raw strings would reject a perfectly good consent and leave the mailbox
 * permanently unconnectable, so both sides are reduced to the bare permission
 * name first.
 */
const normalizeScope = (scope: string): string => {
  let decoded = scope;
  try {
    decoded = decodeURIComponent(scope);
  } catch {
    // A stray `%` is not an encoding; compare what was actually sent.
  }
  return (decoded.split("/").pop() ?? decoded).toLowerCase();
};

/**
 * Turns `AUTH_MICROSOFT_ENTRA_ID_ISSUER` into the directory segment of the
 * OAuth endpoints, so the mailbox connection targets the same directory the
 * dashboard login is pinned to (README, "Autenticació").
 */
export const microsoftTenantFromIssuer = (
  issuer: string | null | undefined,
): string => {
  const trimmed = issuer?.trim();
  if (!trimmed) return MULTI_DIRECTORY_TENANT;

  const [tenant] = new URL(trimmed).pathname.split("/").filter(Boolean);
  return tenant ?? MULTI_DIRECTORY_TENANT;
};

const endpoint = (tenant: string | undefined, action: string): string =>
  `${AUTHORITY}/${tenant ?? MULTI_DIRECTORY_TENANT}/oauth2/v2.0/${action}`;

export interface MicrosoftAuthorizationRequest {
  clientId: string;
  /** Must match a redirect URI registered on the Entra app registration. */
  redirectUri: string;
  /** CSRF token echoed back on the callback. */
  state: string;
  /** S256 challenge derived from the verifier kept by the caller. */
  codeChallenge: string;
  tenant?: string;
}

export const buildMicrosoftAuthorizationUrl = ({
  clientId,
  redirectUri,
  state,
  codeChallenge,
  tenant,
}: MicrosoftAuthorizationRequest): string => {
  const url = new URL(endpoint(tenant, "authorize"));
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: redirectUri,
    scope: SCOPE_PARAM,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

export interface MicrosoftTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  /** What the user actually consented to, as returned by Entra. */
  scopes: string[];
}

export interface MicrosoftCodeExchangeRequest
  extends Omit<MicrosoftAuthorizationRequest, "state" | "codeChallenge"> {
  clientSecret: string;
  code: string;
  codeVerifier: string;
  /** Injected in tests; the token lifetime is relative to this instant. */
  now?: Date;
  fetch?: typeof globalThis.fetch;
}

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const readJson = async <T>(response: Response): Promise<T> => {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(
      `Microsoft returned a non-JSON response (${response.status}).`,
    );
  }
};

export const exchangeMicrosoftAuthorizationCode = async ({
  clientId,
  clientSecret,
  redirectUri,
  code,
  codeVerifier,
  tenant,
  now = new Date(),
  fetch = globalThis.fetch,
}: MicrosoftCodeExchangeRequest): Promise<MicrosoftTokenSet> => {
  const response = await fetch(endpoint(tenant, "token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      scope: SCOPE_PARAM,
    }).toString(),
  });

  const body = await readJson<TokenResponseBody>(response);
  if (!response.ok || body.error) {
    throw new Error(
      `Microsoft token exchange failed: ${body.error ?? response.status}${
        body.error_description ? ` — ${body.error_description}` : ""
      }`,
    );
  }

  if (!body.access_token) {
    throw new Error("Microsoft token exchange returned no access token.");
  }
  // A grant without one is useless past the access token's hour: the mailbox
  // would go silent instead of failing here, where it can still be re-consented.
  if (!body.refresh_token) {
    throw new Error(
      "Microsoft token exchange returned no refresh token — was offline_access consented?",
    );
  }

  const scopes = (body.scope ?? "").split(" ").filter(Boolean);
  const granted = new Set(scopes.map(normalizeScope));
  const missing = REQUIRED_GRAPH_SCOPES.filter(
    (required) => !granted.has(normalizeScope(required)),
  );
  if (missing.length > 0) {
    throw new Error(`Microsoft consent is missing scopes: ${missing.join(", ")}.`);
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(now.getTime() + (body.expires_in ?? 0) * 1000),
    scopes,
  };
};

export interface MicrosoftMailboxIdentity {
  /** Lowercased: mailboxes are unique per (tenant, provider, address). */
  emailAddress: string;
  providerAccountId: string;
}

interface GraphUserBody {
  id?: string;
  mail?: string | null;
  userPrincipalName?: string | null;
  error?: { code?: string; message?: string };
}

/**
 * Which mailbox was just connected. `mail` is the real address; a personal or
 * guest account can leave it empty, and then the principal name is the address.
 */
export const fetchMicrosoftMailboxIdentity = async ({
  accessToken,
  fetch = globalThis.fetch,
}: {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
}): Promise<MicrosoftMailboxIdentity> => {
  const response = await fetch(`${GRAPH_BASE_URL}/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  const body = await readJson<GraphUserBody>(response);
  if (!response.ok) {
    throw new Error(
      `Microsoft Graph /me failed: ${body.error?.code ?? response.status}${
        body.error?.message ? ` — ${body.error.message}` : ""
      }`,
    );
  }

  const emailAddress = (body.mail ?? body.userPrincipalName ?? "").trim();
  if (!emailAddress) {
    throw new Error("Microsoft Graph returned no mailbox address.");
  }
  if (!body.id) {
    throw new Error("Microsoft Graph returned no account id.");
  }

  return {
    emailAddress: emailAddress.toLowerCase(),
    providerAccountId: body.id,
  };
};
