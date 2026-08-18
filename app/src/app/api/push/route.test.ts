// Drives the subscription route the way a request does, with `../../../auth`
// and the store stubbed so no database or OAuth app is needed.

import type { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_TENANT_ID } from "../../../lib/auth/test-fixtures";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const savePushSubscription = vi.fn(async () => {});
const deletePushSubscription = vi.fn(async () => true);

vi.mock("../../../auth", () => ({ auth }));
vi.mock("../../../lib/db", () => ({ db: {} }));
vi.mock("@correu-agent/shared/web-push", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  savePushSubscription,
  deletePushSubscription,
}));

const { DELETE, POST } = await import("./route");

const USER_ID = "33333333-3333-3333-3333-333333333333";

const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "client-public-key", auth: "client-auth-secret" },
};

// The route reads nothing but the JSON body, so a plain request is enough.
const request = (body: unknown): NextRequest =>
  new Request("https://tauler.example/api/push", {
    method: "POST",
    body: JSON.stringify(body),
  }) as NextRequest;

const signedIn = (): void => {
  auth.mockResolvedValue({
    user: {
      id: USER_ID,
      tenantId: TEST_TENANT_ID,
      email: "aleix@example.com",
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
});

describe("POST /api/push", () => {
  it("stores the subscription against the session's tenant and user", async () => {
    signedIn();

    const response = await POST(request(SUBSCRIPTION));

    expect(response.status).toBe(204);
    expect(savePushSubscription).toHaveBeenCalledWith(
      {},
      {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        subscription: SUBSCRIPTION,
      },
    );
  });

  it("stores nothing for a visitor without a session", async () => {
    const response = await POST(request(SUBSCRIPTION));

    expect(response.status).toBe(401);
    expect(savePushSubscription).not.toHaveBeenCalled();
  });

  // A response body is read once when it is sent, so a shared instance would
  // serve the first caller and break for every one after it.
  it("answers every refused request with a readable body", async () => {
    const first = await POST(request(SUBSCRIPTION));
    const second = await POST(request(SUBSCRIPTION));

    await expect(first.json()).resolves.toEqual({
      error: "Cal iniciar la sessió.",
    });
    await expect(second.json()).resolves.toEqual({
      error: "Cal iniciar la sessió.",
    });
  });

  it("refuses a body that is not a push subscription", async () => {
    signedIn();

    const response = await POST(request({ endpoint: "not-a-url" }));

    expect(response.status).toBe(400);
    expect(savePushSubscription).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/push", () => {
  it("forgets the endpoint, scoped to the session's tenant", async () => {
    signedIn();

    const response = await DELETE(request({ endpoint: SUBSCRIPTION.endpoint }));

    expect(response.status).toBe(204);
    expect(deletePushSubscription).toHaveBeenCalledWith(
      {},
      { tenantId: TEST_TENANT_ID, endpoint: SUBSCRIPTION.endpoint },
    );
  });

  it("refuses a body with no endpoint", async () => {
    signedIn();

    const response = await DELETE(request({}));

    expect(response.status).toBe(400);
    expect(deletePushSubscription).not.toHaveBeenCalled();
  });
});
