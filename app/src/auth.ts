import NextAuth from "next-auth";
import { createAuthConfig, parseAllowedEmails } from "./lib/auth/config";
import { createDrizzleAdapter } from "./lib/auth/drizzle-adapter";
import { db } from "./lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth(
  createAuthConfig({
    adapter: createDrizzleAdapter(db),
    allowedEmails: parseAllowedEmails(process.env.AUTH_ALLOWED_EMAILS),
  }),
);
