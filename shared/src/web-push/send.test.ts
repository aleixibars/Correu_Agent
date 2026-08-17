import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_SECONDS,
  buildWebPushRequest,
  serializeNotification,
} from "./send";
import { loadVapidConfig } from "./vapid";
import { parsePushSubscription } from "./subscription";
import { TEST_PUSH_SUBSCRIPTION, TEST_VAPID_ENV } from "./test-fixtures";

const config = loadVapidConfig(TEST_VAPID_ENV);
const subscription = parsePushSubscription(TEST_PUSH_SUBSCRIPTION);
const notification = {
  title: "Correu urgent",
  body: "Client X demana resposta immediata",
  url: "/fils/42",
};

const decodeJwtClaims = (authorization: string): Record<string, unknown> => {
  const token = /vapid t=([^,]+)/.exec(authorization)?.[1];
  if (!token) throw new Error(`No VAPID token in: ${authorization}`);
  const claims = token.split(".")[1];
  return JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
};

describe("serializeNotification", () => {
  it("serialises the fields the service worker reads", () => {
    expect(JSON.parse(serializeNotification(notification))).toEqual({
      title: "Correu urgent",
      body: "Client X demana resposta immediata",
      url: "/fils/42",
    });
  });

  it("omits the url when there is nothing to open", () => {
    const parsed = JSON.parse(
      serializeNotification({ title: "Correu urgent", body: "Sense fil" }),
    );
    expect(parsed).not.toHaveProperty("url");
  });
});

describe("buildWebPushRequest", () => {
  it("targets the subscription endpoint", () => {
    expect(buildWebPushRequest(subscription, notification, config).endpoint).toBe(
      TEST_PUSH_SUBSCRIPTION.endpoint,
    );
  });

  it("signs an Authorization header with the VAPID public key", () => {
    const { headers } = buildWebPushRequest(subscription, notification, config);
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(headers.Authorization).toContain(`k=${config.publicKey}`);
  });

  it("signs the token for the push service origin and the VAPID subject", () => {
    const { headers } = buildWebPushRequest(subscription, notification, config);
    const claims = decodeJwtClaims(headers.Authorization);
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe(config.subject);
    expect(typeof claims.exp).toBe("number");
  });

  it("uses aes128gcm encryption headers", () => {
    const { headers } = buildWebPushRequest(subscription, notification, config);
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Length"]).toBeGreaterThan(0);
  });

  it("defaults to a high-urgency, short-lived notification", () => {
    const { headers } = buildWebPushRequest(subscription, notification, config);
    expect(headers.TTL).toBe(DEFAULT_TTL_SECONDS);
    expect(headers.Urgency).toBe("high");
  });

  it("allows overriding TTL and urgency", () => {
    const { headers } = buildWebPushRequest(subscription, notification, config, {
      ttlSeconds: 60,
      urgency: "normal",
    });
    expect(headers.TTL).toBe(60);
    expect(headers.Urgency).toBe("normal");
  });

  it("encrypts the payload rather than sending it in the clear", () => {
    const { body } = buildWebPushRequest(subscription, notification, config);
    expect(body.length).toBeGreaterThan(0);
    expect(body.toString("utf8")).not.toContain("Correu urgent");
  });
});
