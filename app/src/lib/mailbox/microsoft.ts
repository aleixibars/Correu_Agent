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
import { LOGIN_PATH } from "../routes";
// The outcome the dashboard reads off the URL once the flow is over. The Gmail
// flow writes the same query string and the dashboard reads it, so the names,
// the values and the Catalan copy are spelled in one place.
import {
  mailboxOutcomeQuery,
  type MailboxConnectionReason,
} from "./connect-messages";
import { publicAppUrl } from "./public-url";

export const MICROSOFT_MAILBOX_CONNECT_PATH = "/api/mailbox/microsoft/connect";
export const MICROSOFT_MAILBOX_CALLBACK_PATH =
  "/api/mailbox/microsoft/callback";

/**
 * Holds `<state>.<codeVerifier>` between the two legs of the OAuth flow. Named
 * apart from the Gmail one: the two flows can be half-finished at the same time
 * in the same browser, and Gmail's cookie is scoped to the whole `/api/mailbox`
 * subtree, so a shared name would have them overwrite each other.
 */
export const MICROSOFT_MAILBOX_OAUTH_COOKIE = "correu-mailbox-oauth-microsoft";

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

  const appUrl = (request: NextRequest, path: string): string =>
    publicAppUrl(request, path, env);

  const outcome = (
    request: NextRequest,
    reason?: MailboxConnectionReason,
  ): NextResponse =>
    NextResponse.redirect(appUrl(request, `/?${mailboxOutcomeQuery(reason)}`));

  const connect = async (request: NextRequest): Promise<NextResponse> => {
    const session = await auth();
    if (!session) return NextResponse.redirect(appUrl(request, LOGIN_PATH));

    const redirectUri = appUrl(request, MICROSOFT_MAILBOX_CALLBACK_PATH);
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
      return outcome(request, "oauth_failed");
    }

    const state = randomUrlSafe();
    const codeVerifier = randomUrlSafe();

    const response = NextResponse.redirect(
      buildMicrosoftAuthorizationUrl({
        clientId,
        tenant,
        redirectUri,
        state,
        codeChallenge: pkceChallenge(codeVerifier),
      }),
    );
    response.cookies.set(
      MICROSOFT_MAILBOX_OAUTH_COOKIE,
      `${state}.${codeVerifier}`,
      {
        httpOnly: true,
        // Lax, not strict: the browser arrives back here from Microsoft, and a
        // strict cookie would not be sent on that cross-site navigation.
        sameSite: "lax",
        secure: redirectUri.startsWith("https:"),
        path: MICROSOFT_MAILBOX_CALLBACK_PATH,
        maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
      },
    );
    return response;
  };

  const callback = async (request: NextRequest): Promise<NextResponse> => {
    const session = await auth();
    const query = request.nextUrl.searchParams;
    const [storedState, codeVerifier] = (
      request.cookies.get(MICROSOFT_MAILBOX_OAUTH_COOKIE)?.value ?? ""
    ).split(".");

    const respond = async (): Promise<NextResponse> => {
      // The session can have expired while the user was on the consent screen.
      if (!session) return NextResponse.redirect(appUrl(request, LOGIN_PATH));

      // Either the flow never started in this browser, or the cookie timed out
      // — both are recoverable by starting again from the dashboard.
      if (
        !storedState ||
        !codeVerifier ||
        !matchesStoredState(query.get("state") ?? "", storedState)
      ) {
        return outcome(request, "state_mismatch");
      }

      if (query.get("error") === "access_denied") {
        return outcome(request, "access_denied");
      }
      const code = query.get("code");
      if (query.get("error") || !code) {
        console.error(
          `Microsoft mailbox consent refused: ${query.get("error") ?? "no code returned"}`,
        );
        return outcome(request, "oauth_failed");
      }

      try {
        const { clientId, clientSecret, tenant } = oauthConfig();
        const encryptionKey = loadTokenEncryptionKey(env);

        const tokens = await exchangeMicrosoftAuthorizationCode({
          clientId,
          clientSecret,
          tenant,
          redirectUri: appUrl(request, MICROSOFT_MAILBOX_CALLBACK_PATH),
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
      } catch (error) {
        // The message can carry Entra diagnostics, so it stays in the server log.
        console.error("Failed to connect the Microsoft mailbox:", error);
        return outcome(request, "oauth_failed");
      }

      return outcome(request);
    };

    const response = await respond();
    // The state is single-use whatever the outcome, so a stale cookie can never
    // be replayed against a second callback.
    response.cookies.delete({
      name: MICROSOFT_MAILBOX_OAUTH_COOKIE,
      path: MICROSOFT_MAILBOX_CALLBACK_PATH,
    });
    return response;
  };

  return { connect, callback };
};
