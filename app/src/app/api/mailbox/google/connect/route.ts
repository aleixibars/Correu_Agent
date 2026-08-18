// Starts the Gmail mailbox connection (context.md §9). Thin on purpose: the
// protocol lives in `lib/mailbox/google-oauth.ts`.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "../../../../../auth";
import { LOGIN_PATH } from "../../../../../lib/auth/config";
import {
  MAILBOX_OAUTH_COOKIE,
  MAILBOX_OAUTH_COOKIE_MAX_AGE_SECONDS,
  MAILBOX_OAUTH_COOKIE_PATH,
  createGoogleAuthorizationRequest,
  encodeMailboxOAuthCookie,
  loadGoogleOAuthClient,
  publicAppUrl,
  resolveGoogleCallbackUrl,
} from "../../../../../lib/mailbox/google-oauth";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await auth();
  if (!session) {
    return NextResponse.redirect(publicAppUrl(request, LOGIN_PATH));
  }

  const client = loadGoogleOAuthClient(
    process.env,
    resolveGoogleCallbackUrl(request),
  );
  const authorization = createGoogleAuthorizationRequest(client);

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
