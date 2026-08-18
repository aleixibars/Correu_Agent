// Connecting a Microsoft 365/Outlook mailbox (context.md §9). Separate from the
// dashboard login: signing in with Microsoft only proves who is at the
// dashboard, while this flow asks for the Mail.Read/Mail.Send consent the
// pipeline needs and stores the resulting tokens encrypted in
// `mailbox_accounts`.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { NextResponse, type NextRequest } from "next/server";
import type { Session } from "next-auth";
import {
  buildMicrosoftAuthorizationUrl,
  connectMailboxAccount,
  exchangeMicrosoftAuthorizationCode,
  fetchMicrosoftMailboxIdentity,
  microsoftTenantFromIssuer,
} from "@correu-agent/shared/mailbox";
import { loadTokenEncryptionKey } from "@correu-agent/shared/token-encryption";
import { LOGIN_PATH } from "../auth/config";
// The outcome the dashboard reads off the URL once the flow is over. The Gmail
// flow writes the same query string and the dashboard reads it, so the names
// and the values are spelled in one place.
import {
  MAILBOX_CONNECTED_STATUS,
  MAILBOX_FAILED_STATUS,
  MAILBOX_STATUS_PARAM,
} from "./connect-messages";

export const MICROSOFT_MAILBOX_CONNECT_PATH = "/api/mailboxes/microsoft/connect";
export const MICROSOFT_MAILBOX_CALLBACK_PATH =
  "/api/mailboxes/microsoft/callback";

/** Holds `<state>.<codeVerifier>` between the two legs of the OAuth flow. */
export const MAILBOX_OAUTH_COOKIE = "correu-agent.mailbox-oauth";

/** Long enough for a consent screen, short enough that a stale state is dead. */
const OAUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export interface MicrosoftMailboxHandlerDeps<
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
> {
  auth: () => Promise<Session | null>;
  db: PgDatabase<T, TSchema>;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
}

export interface MicrosoftMailboxHandlers {
  connect: (request: NextRequest) => Promise<NextResponse>;
  callback: (request: NextRequest) => Promise<NextResponse>;
}

/** Chained proxies append rather than replace, so the value can be a list. */
const firstForwarded = (value: string | null): string | undefined =>
  value?.split(",")[0]?.trim() || undefined;

/**
 * Render terminates TLS at its proxy, so the request URL carries an internal
 * host — the redirect URI registered at Entra has to be the public one. The
 * forwarded headers are trusted for the same reason `trustHost` is set on the
 * Auth.js config: on Render they are the only place the public origin appears.
 */
const publicOrigin = (request: NextRequest): string => {
  const host = firstForwarded(request.headers.get("x-forwarded-host"));
  if (!host) return request.nextUrl.origin;
  const protocol =
    firstForwarded(request.headers.get("x-forwarded-proto")) ?? "https";
  return `${protocol}://${host}`;
};

const dashboardResult = (origin: string, result: string): URL => {
  const url = new URL("/", origin);
  url.searchParams.set(MAILBOX_STATUS_PARAM, result);
  return url;
};

const randomUrlSafe = (): string => randomBytes(32).toString("base64url");

const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

const matchesStoredState = (received: string, stored: string): boolean => {
  const a = Buffer.from(received);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
};

const requireEnv = (
  env: Record<string, string | undefined>,
  name: string,
): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — cannot connect a mailbox.`);
  return value;
};

export const createMicrosoftMailboxHandlers = <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown>,
>({
  auth,
  db,
  env = process.env,
  fetch = globalThis.fetch,
}: MicrosoftMailboxHandlerDeps<T, TSchema>): MicrosoftMailboxHandlers => {
  // The mailbox consent reuses the app registration the dashboard login already
  // needs (README, "Autenticació"); only the redirect URI is new.
  const oauthConfig = () => ({
    clientId: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_ID"),
    clientSecret: requireEnv(env, "AUTH_MICROSOFT_ENTRA_ID_SECRET"),
    tenant: microsoftTenantFromIssuer(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER),
  });

  const connect = async (request: NextRequest): Promise<NextResponse> => {
    const origin = publicOrigin(request);
    const session = await auth();
    if (!session) return NextResponse.redirect(new URL(LOGIN_PATH, origin));

    let clientId: string;
    let tenant: string;
    try {
      ({ clientId, tenant } = oauthConfig());
      // Checked here and not only where the tokens are written: without a key
      // the connection cannot succeed, and failing now spares the user a
      // consent screen that grants mail access this app would then throw away.
      loadTokenEncryptionKey(env);
    } catch (error) {
      // The message names the missing variable, so it stays in the server log.
      console.error("Cannot start the Microsoft mailbox connection:", error);
      return NextResponse.redirect(
        dashboardResult(origin, MAILBOX_FAILED_STATUS),
      );
    }

    const state = randomUrlSafe();
    const codeVerifier = randomUrlSafe();

    const response = NextResponse.redirect(
      buildMicrosoftAuthorizationUrl({
        clientId,
        tenant,
        redirectUri: `${origin}${MICROSOFT_MAILBOX_CALLBACK_PATH}`,
        state,
        codeChallenge: pkceChallenge(codeVerifier),
      }),
    );
    response.cookies.set(MAILBOX_OAUTH_COOKIE, `${state}.${codeVerifier}`, {
      httpOnly: true,
      // Lax, not strict: the browser arrives back here from Microsoft, and a
      // strict cookie would not be sent on that cross-site navigation.
      sameSite: "lax",
      secure: origin.startsWith("https:"),
      path: MICROSOFT_MAILBOX_CALLBACK_PATH,
      maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
    });
    return response;
  };

  const callback = async (request: NextRequest): Promise<NextResponse> => {
    const origin = publicOrigin(request);
    const session = await auth();
    if (!session) return NextResponse.redirect(new URL(LOGIN_PATH, origin));

    const [storedState, codeVerifier] = (
      request.cookies.get(MAILBOX_OAUTH_COOKIE)?.value ?? ""
    ).split(".");
    const state = request.nextUrl.searchParams.get("state") ?? "";
    if (!storedState || !codeVerifier || !matchesStoredState(state, storedState)) {
      // Not a user-facing failure: either the flow never started here, or
      // something else sent the browser to this URL.
      return new NextResponse("Estat OAuth invàlid.", { status: 400 });
    }

    const finish = (result: string): NextResponse => {
      const response = NextResponse.redirect(dashboardResult(origin, result));
      // One-shot state: it must not be replayable after this exchange.
      response.cookies.set(MAILBOX_OAUTH_COOKIE, "", {
        path: MICROSOFT_MAILBOX_CALLBACK_PATH,
        maxAge: 0,
      });
      return response;
    };

    const providerError = request.nextUrl.searchParams.get("error");
    const code = request.nextUrl.searchParams.get("code");
    if (providerError || !code) {
      console.error(
        `Microsoft mailbox consent refused: ${providerError ?? "no code returned"}`,
      );
      return finish(MAILBOX_FAILED_STATUS);
    }

    try {
      const { clientId, clientSecret, tenant } = oauthConfig();
      const encryptionKey = loadTokenEncryptionKey(env);

      const tokens = await exchangeMicrosoftAuthorizationCode({
        clientId,
        clientSecret,
        tenant,
        redirectUri: `${origin}${MICROSOFT_MAILBOX_CALLBACK_PATH}`,
        code,
        codeVerifier,
        fetch,
      });

      const identity = await fetchMicrosoftMailboxIdentity({
        accessToken: tokens.accessToken,
        fetch,
      });

      await connectMailboxAccount(db, {
        tenantId: session.user.tenantId,
        userId: session.user.id,
        provider: "microsoft",
        emailAddress: identity.emailAddress,
        providerAccountId: identity.providerAccountId,
        tokens,
        encryptionKey,
      });

      return finish(MAILBOX_CONNECTED_STATUS);
    } catch (error) {
      // The message can carry Entra diagnostics, so it stays in the server log.
      console.error("Failed to connect the Microsoft mailbox:", error);
      return finish(MAILBOX_FAILED_STATUS);
    }
  };

  return { connect, callback };
};
