import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_TOKEN_ENDPOINT,
  loadGoogleOAuthCredentials,
  refreshGoogleAccessToken,
} from "./google-tokens";

const CREDENTIALS = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadGoogleOAuthCredentials", () => {
  it("reads the same app credentials the connection flow uses", () => {
    expect(
      loadGoogleOAuthCredentials({
        AUTH_GOOGLE_ID: "id-1",
        AUTH_GOOGLE_SECRET: "secret-1",
      }),
    ).toEqual({ clientId: "id-1", clientSecret: "secret-1" });
  });

  it("refuses to run without them", () => {
    expect(() => loadGoogleOAuthCredentials({ AUTH_GOOGLE_ID: "id-1" })).toThrow(
      /AUTH_GOOGLE_SECRET/,
    );
  });
});

describe("refreshGoogleAccessToken", () => {
  it("exchanges the refresh token for a fresh access token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ access_token: "access-2", expires_in: 3599 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const before = Date.now();
    const token = await refreshGoogleAccessToken(CREDENTIALS, "refresh-1");

    expect(token.accessToken).toBe("access-2");
    expect(token.expiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 3599 * 1000,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(body.get("client_id")).toBe(CREDENTIALS.clientId);
    expect(body.get("client_secret")).toBe(CREDENTIALS.clientSecret);
  });

  it("reports the reason Google refused the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: "invalid_grant" }, 400),
      ),
    );

    await expect(
      refreshGoogleAccessToken(CREDENTIALS, "refresh-1"),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("fails when Google answers without an access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ expires_in: 3599 })),
    );

    await expect(
      refreshGoogleAccessToken(CREDENTIALS, "refresh-1"),
    ).rejects.toThrow(/access token/i);
  });
});
