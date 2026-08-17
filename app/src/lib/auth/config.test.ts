import { NextRequest } from "next/server";
import NextAuth from "next-auth";
import type { AdapterUser } from "next-auth/adapters";
import { describe, expect, it } from "vitest";
import { createAuthConfig, isEmailAllowed, parseAllowedEmails } from "./config";
import {
  TEST_AUTH_ENV,
  TEST_TENANT_ID,
  createInMemoryAdapter,
  type InMemoryAdapter,
} from "./test-fixtures";

// Auth.js reads its client credentials from the environment, so the whole suite
// runs against the fixture values rather than a real Google/Entra app.
Object.assign(process.env, TEST_AUTH_ENV);

const ALLOWED_EMAIL = "aleix@example.com";

/** Non-`__Secure-` variant, because the requests below are plain http. */
const SESSION_COOKIE = "authjs.session-token";

const TEST_USER: AdapterUser = {
  id: "user-1",
  email: ALLOWED_EMAIL,
  emailVerified: null,
  name: "Aleix",
  image: null,
  tenantId: TEST_TENANT_ID,
};

const inOneHour = (): Date => new Date(Date.now() + 60 * 60 * 1000);

const authFor = (adapter: InMemoryAdapter) =>
  NextAuth(createAuthConfig({ adapter, allowedEmails: [ALLOWED_EMAIL] }));

const get = (path: string, cookie?: string): NextRequest =>
  new NextRequest(`http://localhost:3000/api/auth/${path}`, {
    headers: cookie ? { cookie } : undefined,
  });

describe("createAuthConfig", () => {
  it("returns the signed-in user and tenant for a stored session", async () => {
    const adapter = createInMemoryAdapter({
      users: [TEST_USER],
      sessions: [
        {
          sessionToken: "session-token-1",
          userId: TEST_USER.id,
          expires: inOneHour(),
        },
      ],
    });

    const response = await authFor(adapter).handlers.GET(
      get("session", `${SESSION_COOKIE}=session-token-1`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        id: TEST_USER.id,
        email: ALLOWED_EMAIL,
        name: "Aleix",
        tenantId: TEST_TENANT_ID,
      },
    });
  });

  it("reports no session when the stored session has expired", async () => {
    const adapter = createInMemoryAdapter({
      users: [TEST_USER],
      sessions: [
        {
          sessionToken: "expired-token",
          userId: TEST_USER.id,
          expires: new Date(Date.now() - 1000),
        },
      ],
    });

    const response = await authFor(adapter).handlers.GET(
      get("session", `${SESSION_COOKIE}=expired-token`),
    );

    await expect(response.json()).resolves.toBeNull();
    // An expired session is dropped rather than left around to be extended.
    expect(adapter.sessions.has("expired-token")).toBe(false);
  });

  it("reports no session without a session cookie", async () => {
    const response = await authFor(createInMemoryAdapter()).handlers.GET(
      get("session"),
    );

    await expect(response.json()).resolves.toBeNull();
  });

  it("offers Google and Microsoft as the two login providers", async () => {
    const response = await authFor(createInMemoryAdapter()).handlers.GET(
      get("providers"),
    );

    await expect(response.json()).resolves.toMatchObject({
      google: { id: "google" },
      "microsoft-entra-id": { id: "microsoft-entra-id" },
    });
  });

  it("keeps sessions in the database, so signing out is final", () => {
    const config = createAuthConfig({
      adapter: createInMemoryAdapter(),
      allowedEmails: [ALLOWED_EMAIL],
    });

    expect(config.session?.strategy).toBe("database");
  });

  it("only lets an allowlisted address sign in", async () => {
    const config = createAuthConfig({
      adapter: createInMemoryAdapter(),
      allowedEmails: [ALLOWED_EMAIL],
    });
    const signIn = config.callbacks!.signIn!;

    await expect(
      signIn({ user: TEST_USER, account: null }),
    ).resolves.toBe(true);
    await expect(
      signIn({ user: { ...TEST_USER, email: "estranya@example.com" }, account: null }),
    ).resolves.toBe(false);
  });
});

describe("isEmailAllowed", () => {
  it("matches case-insensitively, since providers vary on casing", () => {
    expect(isEmailAllowed("Aleix@Example.com", [ALLOWED_EMAIL])).toBe(true);
  });

  it("lets nobody in when no allowlist is configured", () => {
    // Fail closed: an empty allowlist on a single-tenant PoC would otherwise
    // hand the connected mailbox to anyone with a Google account.
    expect(isEmailAllowed(ALLOWED_EMAIL, [])).toBe(false);
  });

  it("rejects a user with no email address", () => {
    expect(isEmailAllowed(undefined, [ALLOWED_EMAIL])).toBe(false);
  });
});

describe("parseAllowedEmails", () => {
  it("splits, trims and drops empty entries", () => {
    expect(parseAllowedEmails(" a@example.com , b@example.com ,, ")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("treats an unset variable as an empty allowlist", () => {
    expect(parseAllowedEmails(undefined)).toEqual([]);
  });
});
