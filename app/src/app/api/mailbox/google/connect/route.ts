// Starts the Gmail mailbox connection (context.md §9). Thin on purpose: the
// protocol lives in `lib/mailbox/google-oauth.ts`.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "../../../../../auth";
import { LOGIN_PATH } from "../../../../../lib/routes";
import { mailboxOutcomeQuery } from "../../../../../lib/mailbox/connect-messages";
import { publicAppUrl } from "../../../../../lib/mailbox/public-url";
import {
  MAILBOX_OAUTH_COOKIE,
  MAILBOX_OAUTH_COOKIE_MAX_AGE_SECONDS,
  MAILBOX_OAUTH_COOKIE_PATH,
  createGoogleAuthorizationRequest,
  encodeMailboxOAuthCookie,
  loadGoogleOAuthClient,
  resolveGoogleCallbackUrl,
} from "../../../../../lib/mailbox/google-oauth";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await auth();
  if (!session) {
    return NextResponse.redirect(publicAppUrl(request, LOGIN_PATH));
  }

  let authorization;
  try {
    authorization = createGoogleAuthorizationRequest(
      loadGoogleOAuthClient(process.env, resolveGoogleCallbackUrl(request)),
    );
  } catch (error) {
    // Missing Google credentials are a deployment mistake, not something the
    // user did — but a raw 500 would say so in English, so it lands on the
    // dashboard with the same Catalan notice as any other failed attempt.
    console.error("Could not start the Gmail mailbox connection:", error);
    return NextResponse.redirect(
      publicAppUrl(request, `/?${mailboxOutcomeQuery("oauth_failed")}`),
    );
  }

  const response = NextResponse.redirect(authorization.url);
  response.cookies.set(
    MAILBOX_OAUTH_COOKIE,
    encodeMailboxOAuthCookie(authorization),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: MAILBOX_OAUTH_COOKIE_PATH,
      maxAge: MAILBOX_OAUTH_COOKIE_MAX_AGE_SECONDS,
    },
  );
  return response;
};
