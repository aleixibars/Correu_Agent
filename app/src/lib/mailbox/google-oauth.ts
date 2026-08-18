// OAuth flow that connects a Gmail mailbox (context.md §9). Separate from the
// dashboard login in `../auth/`: signing in only proves who is at the keyboard,
// while this flow asks for the Gmail read/send grant whose tokens are persisted
// — encrypted — on `mailbox_accounts`, and are later used by the worker with
// nobody present.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_PROFILE_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** Where Google sends the user back after the consent screen. */
export const GOOGLE_CALLBACK_PATH = "/api/mailbox/google/callback";

/**
 * Read and send, the two grants the product needs (context.md §2), plus
 * `openid` for the stable account subject. The mailbox address and the history
 * cursor come from the Gmail profile, so no extra profile scope is requested.
 */
export const GOOGLE_MAILBOX_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleAuthorizationRequest {
  state: string;
  codeVerifier: string;
  url: string;
}

export interface GoogleTokenSet {
  accessToken: string;
  /** Null when Google re-consents an already-authorised account without re-issuing one. */
  refreshToken: string | null;
  expiresAt: Date | null;
  idToken: string | null;
  /** What the user actually granted, which can be less than what was asked for. */
  scopes: string[];
}

export interface GmailProfile {
  emailAddress: string;
  /** Gmail `historyId` — the point polling resumes from (context.md §4, §8). */
  historyId: string;
}

/**
 * The mailbox connection reuses the dashboard login's Google app (context.md
 * §9), so there is a single OAuth client to register and a single pair of
 * secrets to rotate.
 */
export const loadGoogleOAuthClient = (
  env: Record<string, string | undefined>,
  redirectUri: string,
): GoogleOAuthClient => {
  const clientId = env.AUTH_GOOGLE_ID;
  const clientSecret = env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are required to connect a Gmail mailbox.",
    );
  }
  return { clientId, clientSecret, redirectUri };
};

/**
 * Google matches the redirect URI against the registered one character for
 * character, and Render terminates TLS at a proxy — so the public URL is
 * configuration (`AUTH_URL`), with the request origin as the local fallback.
 */
export const publicAppUrl = (
  request: Request,
  path: string,
  env: Record<string, string | undefined> = process.env,
): string =>
  new URL(path, env.AUTH_URL ?? new URL(request.url).origin).toString();

export const resolveGoogleCallbackUrl = (
  request: Request,
  env: Record<string, string | undefined> = process.env,
): string => publicAppUrl(request, GOOGLE_CALLBACK_PATH, env);

const randomToken = (): string => randomBytes(32).toString("base64url");

const codeChallengeFor = (codeVerifier: string): string =>
  createHash("sha256").update(codeVerifier).digest("base64url");

export const buildGoogleAuthorizationUrl = (
  client: GoogleOAuthClient,
  state: string,
  codeVerifier: string,
): string => {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: GOOGLE_MAILBOX_SCOPES.join(" "),
    state,
    // The worker polls the mailbox with nobody signed in, so a refresh token is
    // mandatory — and Google only re-issues one when consent is asked again.
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallengeFor(codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

export const createGoogleAuthorizationRequest = (
  client: GoogleOAuthClient,
): GoogleAuthorizationRequest => {
  const state = randomToken();
  const codeVerifier = randomToken();
  return {
    state,
    codeVerifier,
    url: buildGoogleAuthorizationUrl(client, state, codeVerifier),
  };
};

/**
 * State and verifier travel back in one http-only cookie: the state proves the
 * callback answers a request this browser started, and the verifier proves the
 * code is redeemed by whoever asked for it.
 */
export const MAILBOX_OAUTH_COOKIE = "correu-mailbox-oauth";

/** Scoped to the routes that read it back, so it never rides along elsewhere. */
export const MAILBOX_OAUTH_COOKIE_PATH = "/api/mailbox";

/** How long the user has to get through Google's consent screen. */
export const MAILBOX_OAUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export const encodeMailboxOAuthCookie = ({
  state,
  codeVerifier,
}: Pick<GoogleAuthorizationRequest, "state" | "codeVerifier">): string =>
  `${state}.${codeVerifier}`;

const equalTokens = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Returns the code verifier when the callback's `state` matches the cookie, and
 * `null` otherwise — a forged callback would otherwise connect the attacker's
 * mailbox to the signed-in user's tenant.
 */
export const verifyMailboxOAuthCookie = (
  cookieValue: string | undefined,
  state: string | null,
): string | null => {
  if (!cookieValue || !state) return null;

  const separator = cookieValue.indexOf(".");
  if (separator <= 0) return null;

  const expectedState = cookieValue.slice(0, separator);
  const codeVerifier = cookieValue.slice(separator + 1);
  if (!codeVerifier || !equalTokens(expectedState, state)) return null;

  return codeVerifier;
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const errorDetail = (body: Record<string, unknown>): string => {
  const { error, error_description: description } = body;
  if (typeof description === "string") return description;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "unknown error";
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

export const exchangeGoogleAuthorizationCode = async (
  client: GoogleOAuthClient,
  { code, codeVerifier }: { code: string; codeVerifier: string },
): Promise<GoogleTokenSet> => {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
    }).toString(),
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `Google refused the authorization code (${response.status}): ${errorDetail(body)}`,
    );
  }

  const accessToken = optionalString(body.access_token);
  if (!accessToken) {
    throw new Error("Google returned no access token for the mailbox.");
  }

  const expiresIn = body.expires_in;
  const scope = optionalString(body.scope);

  return {
    accessToken,
    refreshToken: optionalString(body.refresh_token),
    expiresAt:
      typeof expiresIn === "number"
        ? new Date(Date.now() + expiresIn * 1000)
        : null,
    idToken: optionalString(body.id_token),
    scopes: scope ? scope.split(" ") : [],
  };
};

export const fetchGmailProfile = async (
  accessToken: string,
): Promise<GmailProfile> => {
  const response = await fetch(GMAIL_PROFILE_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `Gmail refused the profile request (${response.status}): ${errorDetail(body)}`,
    );
  }

  const emailAddress = optionalString(body.emailAddress);
  if (!emailAddress) {
    throw new Error("Gmail returned no address for the connected mailbox.");
  }

  // Gmail sends the historyId as a string, but the API reference types it as a
  // uint64, so a numeric one is accepted too. It is refused when absent rather
  // than stored empty: an empty cursor is not "start from now", it is a cursor
  // the worker cannot resume from, and only new mail is ever processed (§4).
  const historyId =
    typeof body.historyId === "number"
      ? String(body.historyId)
      : optionalString(body.historyId);
  if (!historyId) {
    throw new Error("Gmail returned no historyId to resume polling from.");
  }

  return { emailAddress, historyId };
};

/**
 * The `sub` claim, used as `providerAccountId`: unlike the address it never
 * changes for a Google account. The token comes straight from Google's token
 * endpoint over TLS, so its signature needs no separate check (OIDC Core
 * §3.1.3.7) — it is not accepted from the browser anywhere.
 */
export const googleAccountIdFromIdToken = (idToken: string): string => {
  const [, payload] = idToken.split(".");
  if (!payload) throw new Error("Malformed Google id_token.");

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed Google id_token.");
  }

  const subject =
    claims && typeof claims === "object"
      ? optionalString((claims as { sub?: unknown }).sub)
      : null;
  if (!subject) throw new Error("Google id_token carries no subject.");

  return subject;
};
