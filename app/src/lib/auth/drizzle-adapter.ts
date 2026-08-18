// Auth.js adapter over the project's own Drizzle schema (context.md §9).
//
// `@auth/drizzle-adapter` is not used because it owns its table shapes: it has
// no notion of the `tenantId` every row here carries, and it would persist the
// provider's raw OAuth tokens, which the standards forbid. The dashboard login
// only needs the identity link, so this adapter stores just that.

import { and, asc, eq, sql } from "drizzle-orm";
import type { Adapter, AdapterSession, AdapterUser } from "next-auth/adapters";
import { APP_NAME } from "@correu-agent/shared";
import {
  authAccounts,
  authSessions,
  tenants,
  users,
  type User,
} from "@correu-agent/shared/db/schema";
import type { Database } from "../db";

// Arbitrary but fixed: two first-ever logins racing each other would otherwise
// each see an empty `tenants` table and create a tenant of their own.
const TENANT_BOOTSTRAP_LOCK = 8_921_734;

const toAdapterUser = (user: User): AdapterUser => ({
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerifiedAt,
  name: user.name,
  image: user.imageUrl,
  tenantId: user.tenantId,
});

const toAdapterSession = (session: {
  sessionToken: string;
  userId: string;
  expires: Date;
}): AdapterSession => ({
  sessionToken: session.sessionToken,
  userId: session.userId,
  expires: session.expires,
});

/**
 * The PoC is single-tenant (context.md §1): whoever signs in joins the one
 * tenant row, which the first login creates.
 */
const resolveTenantId = (db: Database): Promise<string> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${TENANT_BOOTSTRAP_LOCK})`);
    const [existing] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .orderBy(asc(tenants.createdAt))
      .limit(1);
    if (existing) return existing.id;

    const [created] = await tx
      .insert(tenants)
      .values({ name: APP_NAME })
      .returning({ id: tenants.id });
    return created!.id;
  });

const tenantIdOf = async (db: Database, userId: string): Promise<string> => {
  const [user] = await db
    .select({ tenantId: users.tenantId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new Error(`No user ${userId} to attach the login to.`);
  return user.tenantId;
};

export const createDrizzleAdapter = (db: Database): Adapter => ({
  createUser: async ({ email, name, image, emailVerified }) => {
    const [created] = await db
      .insert(users)
      .values({
        tenantId: await resolveTenantId(db),
        email,
        name,
        imageUrl: image,
        emailVerifiedAt: emailVerified,
      })
      .returning();
    return toAdapterUser(created!);
  },

  getUser: async (id) => {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user ? toAdapterUser(user) : null;
  },

  // Emails are unique per tenant, not globally (`users` unique constraint), so
  // this lookup is only unambiguous while the PoC has a single tenant.
  getUserByEmail: async (email) => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return user ? toAdapterUser(user) : null;
  },

  getUserByAccount: async ({ provider, providerAccountId }) => {
    const [row] = await db
      .select({ user: users })
      .from(authAccounts)
      .innerJoin(users, eq(users.id, authAccounts.userId))
      .where(
        and(
          eq(authAccounts.provider, provider),
          eq(authAccounts.providerAccountId, providerAccountId),
        ),
      )
      .limit(1);
    return row ? toAdapterUser(row.user) : null;
  },

  updateUser: async ({ id, email, name, image, emailVerified }) => {
    const [updated] = await db
      .update(users)
      .set({
        email,
        name,
        imageUrl: image,
        emailVerifiedAt: emailVerified,
      })
      .where(eq(users.id, id))
      .returning();
    if (!updated) throw new Error(`No user ${id} to update.`);
    return toAdapterUser(updated);
  },

  // Accounts and sessions cascade with the user row.
  deleteUser: async (userId) => {
    await db.delete(users).where(eq(users.id, userId));
  },

  linkAccount: async ({ userId, type, provider, providerAccountId }) => {
    await db
      .insert(authAccounts)
      .values({
        tenantId: await tenantIdOf(db, userId),
        userId,
        type,
        provider,
        providerAccountId,
      })
      .onConflictDoNothing();
  },

  unlinkAccount: async ({ provider, providerAccountId }) => {
    await db
      .delete(authAccounts)
      .where(
        and(
          eq(authAccounts.provider, provider),
          eq(authAccounts.providerAccountId, providerAccountId),
        ),
      );
  },

  createSession: async ({ sessionToken, userId, expires }) => {
    await db.insert(authSessions).values({
      sessionToken,
      tenantId: await tenantIdOf(db, userId),
      userId,
      expires,
    });
    return { sessionToken, userId, expires };
  },

  getSessionAndUser: async (sessionToken) => {
    const [row] = await db
      .select({ session: authSessions, user: users })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(eq(authSessions.sessionToken, sessionToken))
      .limit(1);
    return row
      ? { session: toAdapterSession(row.session), user: toAdapterUser(row.user) }
      : null;
  },

  updateSession: async ({ sessionToken, userId, expires }) => {
    const [updated] = await db
      .update(authSessions)
      .set({ userId, expires })
      .where(eq(authSessions.sessionToken, sessionToken))
      .returning();
    return updated ? toAdapterSession(updated) : null;
  },

  deleteSession: async (sessionToken) => {
    await db
      .delete(authSessions)
      .where(eq(authSessions.sessionToken, sessionToken));
  },
});
