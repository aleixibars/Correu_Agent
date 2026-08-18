// Auth.js configuration for the dashboard login (context.md §9): Google and
// Microsoft Entra ID, database sessions, and the tenant carried through into
// the session so every query downstream can scope itself.

import type { DefaultSession, NextAuthConfig, Profile } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

declare module "next-auth" {
  interface Session {
    user: { id: string; tenantId: string } & DefaultSession["user"];
  }
}

declare module "next-auth/adapters" {
  interface AdapterUser {
    tenantId: string;
  }
}

/** Where an unauthenticated visitor is sent, and where the login buttons live. */
export const LOGIN_PATH = "/login";

/** Where a visitor lands once signed in. */
export const DASHBOARD_PATH = "/";

/** The processed-thread list of the dashboard (context.md §2). */
export const THREADS_PATH = "/fils";

export interface AuthConfigOptions {
  adapter: Adapter;
  /** Addresses allowed to sign in; anything else is turned away. */
  allowedEmails: readonly string[];
}

/** Reads the comma-separated `AUTH_ALLOWED_EMAILS` variable. */
export const parseAllowedEmails = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email !== "");

// The PoC has no signup: a single tenant with one connected mailbox (context.md
// §1), so an open Google login would hand that mailbox to any Google account.
// An unset allowlist therefore lets nobody in rather than everybody.
export const isEmailAllowed = (
  email: string | null | undefined,
  allowedEmails: readonly string[],
): boolean =>
  email != null &&
  allowedEmails.some(
    (allowed) => allowed.toLowerCase() === email.toLowerCase(),
  );

// Claims where a provider states whether it vouches for the address: the OIDC
// standard `email_verified`, and Microsoft Entra ID's `xms_edov` optional claim
// (emitted as a boolean, or as a string in older token versions).
const EMAIL_VERIFIED_CLAIMS = ["email_verified", "xms_edov"] as const;

const vouchedAgainst = (claim: unknown): boolean =>
  claim === false || claim === "false" || claim === 0 || claim === "0";

/**
 * Microsoft's `email` claim is not proof of ownership: any Entra directory can
 * set it to an arbitrary address, and the default `common` issuer accepts every
 * directory. Since the allowlist is the only gate here, an address the provider
 * explicitly refuses to vouch for is turned away. Absent claims still pass —
 * Entra only emits `xms_edov` once it is configured as an optional claim, so
 * pinning `AUTH_MICROSOFT_ENTRA_ID_ISSUER` stays the stronger control (README).
 */
export const isEmailVouchedFor = (
  profile: Profile | null | undefined,
): boolean =>
  EMAIL_VERIFIED_CLAIMS.every((claim) => !vouchedAgainst(profile?.[claim]));

export const createAuthConfig = ({
  adapter,
  allowedEmails,
}: AuthConfigOptions): NextAuthConfig => ({
  adapter,
  // Render sits behind a proxy and is not auto-detected the way Vercel is, so
  // the host from the forwarded request headers has to be trusted explicitly.
  trustHost: true,
  providers: [Google, MicrosoftEntraID],
  // Sessions live in Postgres, so signing out (or deleting the row) really ends
  // access, unlike a JWT that stays valid until it expires.
  session: { strategy: "database" },
  // Errors land back on the login page, which explains them in Catalan,
  // instead of on Auth.js's built-in English error page.
  pages: { signIn: LOGIN_PATH, error: LOGIN_PATH },
  callbacks: {
    signIn: async ({ user, profile }) =>
      isEmailAllowed(user.email, allowedEmails) && isEmailVouchedFor(profile),
    session: async ({ session, user }) => ({
      ...session,
      user: { ...session.user, id: user.id, tenantId: user.tenantId },
    }),
  },
});
