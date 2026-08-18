// The worker polls a connected mailbox with nobody signed in (context.md §8),
// so the encrypted refresh token stored at connection time is the only
// credential it has: the short-lived access token is minted from it here.

import { errorDetail, readJson } from "./google-errors";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** The mailbox grant reuses the dashboard's Google app (context.md §9) — one pair of secrets. */
export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GoogleAccessToken {
  accessToken: string;
  /** Null when Google answers without an expiry; the next poll then refreshes again. */
  expiresAt: Date | null;
}

export const loadGoogleOAuthCredentials = (
  env: Record<string, string | undefined> = process.env,
): GoogleOAuthCredentials => {
  const clientId = env.AUTH_GOOGLE_ID;
  const clientSecret = env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are required to poll a Gmail mailbox.",
    );
  }
  return { clientId, clientSecret };
};

export const refreshGoogleAccessToken = async (
  { clientId, clientSecret }: GoogleOAuthCredentials,
  refreshToken: string,
): Promise<GoogleAccessToken> => {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `Google refused the mailbox refresh token (${response.status}): ${errorDetail(body)}`,
    );
  }

  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new Error("Google returned no access token for the mailbox.");
  }

  const expiresIn = body.expires_in;
  return {
    accessToken,
    expiresAt:
      typeof expiresIn === "number"
        ? new Date(Date.now() + expiresIn * 1000)
        : null,
  };
};
