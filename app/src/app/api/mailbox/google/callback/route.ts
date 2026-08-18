// Where Google sends the user back after the consent screen. Validates the
// callback, hands the code to `connectGoogleMailbox` and reports the outcome on
// the dashboard.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "../../../../../auth";
import { LOGIN_PATH } from "../../../../../lib/auth/config";
import { db } from "../../../../../lib/db";
import {
  MailboxConnectionError,
  connectGoogleMailbox,
} from "../../../../../lib/mailbox/connect-google-mailbox";
import {
  mailboxOutcomeQuery,
  type MailboxConnectionReason,
} from "../../../../../lib/mailbox/connect-messages";
import { publicAppUrl } from "../../../../../lib/mailbox/public-url";
import {
  MAILBOX_OAUTH_COOKIE,
  MAILBOX_OAUTH_COOKIE_PATH,
  loadGoogleOAuthClient,
  resolveGoogleCallbackUrl,
  verifyMailboxOAuthCookie,
} from "../../../../../lib/mailbox/google-oauth";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await auth();

  const query = request.nextUrl.searchParams;
  const codeVerifier = verifyMailboxOAuthCookie(
    request.cookies.get(MAILBOX_OAUTH_COOKIE)?.value,
    query.get("state"),
  );
  const code = query.get("code");

  const outcome = (reason?: MailboxConnectionReason): NextResponse =>
    NextResponse.redirect(
      publicAppUrl(request, `/?${mailboxOutcomeQuery(reason)}`),
    );

  const respond = async (): Promise<NextResponse> => {
    // The session can have expired while the user was on the consent screen.
    if (!session) {
      return NextResponse.redirect(publicAppUrl(request, LOGIN_PATH));
    }
    if (query.get("error") === "access_denied") return outcome("access_denied");
    // Anything else Google reports is a protocol-level refusal, not a decision
    // the user made on the consent screen.
    if (query.get("error")) return outcome("oauth_failed");
    if (!codeVerifier) return outcome("state_mismatch");
    if (!code) return outcome("oauth_failed");

    try {
      await connectGoogleMailbox(db, {
        tenantId: session.user.tenantId,
        userId: session.user.id,
        code,
        codeVerifier,
        client: loadGoogleOAuthClient(
          process.env,
          resolveGoogleCallbackUrl(request),
        ),
      });
    } catch (error) {
      console.error("Could not connect the Gmail mailbox:", error);
      return outcome(
        error instanceof MailboxConnectionError ? error.code : "oauth_failed",
      );
    }

    return outcome();
  };

  const response = await respond();
  // The state is single-use whatever the outcome, so a stale cookie can never
  // be replayed against a second callback.
  response.cookies.delete({
    name: MAILBOX_OAUTH_COOKIE,
    path: MAILBOX_OAUTH_COOKIE_PATH,
  });
  return response;
};
