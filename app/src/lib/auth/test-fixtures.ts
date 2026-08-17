// In-memory Auth.js adapter, used to drive the auth handlers in tests without a
// database. Mirrors the behaviour `drizzle-adapter.ts` implements against
// Postgres, including the `tenantId` every user carries (context.md §7).

import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
} from "next-auth/adapters";

export const TEST_TENANT_ID = "11111111-1111-1111-1111-111111111111";

export const TEST_AUTH_ENV = {
  AUTH_SECRET: "test-secret-with-enough-entropy-for-authjs",
  AUTH_GOOGLE_ID: "google-client-id",
  AUTH_GOOGLE_SECRET: "google-client-secret",
  AUTH_MICROSOFT_ENTRA_ID_ID: "entra-client-id",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-client-secret",
} as const;

export interface InMemoryAdapter extends Required<
  Pick<
    Adapter,
    | "createUser"
    | "getUser"
    | "getUserByEmail"
    | "getUserByAccount"
    | "updateUser"
    | "deleteUser"
    | "linkAccount"
    | "unlinkAccount"
    | "createSession"
    | "getSessionAndUser"
    | "updateSession"
    | "deleteSession"
  >
> {
  users: Map<string, AdapterUser>;
  sessions: Map<string, AdapterSession>;
  accounts: Map<string, AdapterAccount>;
}

const accountKey = ({
  provider,
  providerAccountId,
}: Pick<AdapterAccount, "provider" | "providerAccountId">): string =>
  `${provider}:${providerAccountId}`;

export const createInMemoryAdapter = (
  seed: { users?: AdapterUser[]; sessions?: AdapterSession[] } = {},
): InMemoryAdapter => {
  const users = new Map((seed.users ?? []).map((user) => [user.id, user]));
  const sessions = new Map(
    (seed.sessions ?? []).map((session) => [session.sessionToken, session]),
  );
  const accounts = new Map<string, AdapterAccount>();
  let nextId = users.size + 1;

  const requireUser = (id: string): AdapterUser => {
    const user = users.get(id);
    if (!user) throw new Error(`Unknown user ${id}`);
    return user;
  };

  return {
    users,
    sessions,
    accounts,
    createUser: async (user) => {
      const created: AdapterUser = {
        ...user,
        id: `user-${nextId++}`,
        tenantId: TEST_TENANT_ID,
      };
      users.set(created.id, created);
      return created;
    },
    getUser: async (id) => users.get(id) ?? null,
    getUserByEmail: async (email) =>
      [...users.values()].find((user) => user.email === email) ?? null,
    getUserByAccount: async (providerAccountId) => {
      const account = accounts.get(accountKey(providerAccountId));
      return account ? users.get(account.userId) ?? null : null;
    },
    updateUser: async ({ id, ...changes }) => {
      const updated = { ...requireUser(id), ...changes };
      users.set(id, updated);
      return updated;
    },
    deleteUser: async (id) => {
      users.delete(id);
    },
    linkAccount: async (account) => {
      accounts.set(accountKey(account), account);
    },
    unlinkAccount: async (providerAccountId) => {
      accounts.delete(accountKey(providerAccountId));
    },
    createSession: async (session) => {
      sessions.set(session.sessionToken, session);
      return session;
    },
    getSessionAndUser: async (sessionToken) => {
      const session = sessions.get(sessionToken);
      if (!session) return null;
      return { session, user: requireUser(session.userId) };
    },
    updateSession: async ({ sessionToken, ...changes }) => {
      const session = sessions.get(sessionToken);
      if (!session) return null;
      const updated = { ...session, ...changes };
      sessions.set(sessionToken, updated);
      return updated;
    },
    deleteSession: async (sessionToken) => {
      sessions.delete(sessionToken);
    },
  };
};
