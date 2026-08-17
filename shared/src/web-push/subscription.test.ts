import { describe, expect, it } from "vitest";
import { parsePushSubscription } from "./subscription";
import { TEST_PUSH_SUBSCRIPTION } from "./test-fixtures";

describe("parsePushSubscription", () => {
  it("accepts the JSON a browser PushManager subscription serialises to", () => {
    expect(parsePushSubscription(TEST_PUSH_SUBSCRIPTION)).toEqual({
      endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
      keys: {
        p256dh: TEST_PUSH_SUBSCRIPTION.keys.p256dh,
        auth: TEST_PUSH_SUBSCRIPTION.keys.auth,
      },
    });
  });

  it("drops extra fields the browser adds, such as expirationTime", () => {
    const parsed = parsePushSubscription({
      ...TEST_PUSH_SUBSCRIPTION,
      expirationTime: null,
    });
    expect(parsed).not.toHaveProperty("expirationTime");
  });

  it("rejects a non-object body", () => {
    expect(() => parsePushSubscription("nope")).toThrow(/subscription/i);
  });

  it("rejects an endpoint that is not an https URL", () => {
    expect(() =>
      parsePushSubscription({
        ...TEST_PUSH_SUBSCRIPTION,
        endpoint: "http://fcm.googleapis.com/fcm/send/abc123",
      }),
    ).toThrow(/endpoint/i);
  });

  it("rejects an endpoint that is not a URL at all", () => {
    expect(() =>
      parsePushSubscription({ ...TEST_PUSH_SUBSCRIPTION, endpoint: "https://" }),
    ).toThrow(/endpoint/i);
  });

  it("rejects a missing p256dh key", () => {
    expect(() =>
      parsePushSubscription({
        endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
        keys: { auth: TEST_PUSH_SUBSCRIPTION.keys.auth },
      }),
    ).toThrow(/p256dh/i);
  });

  it("rejects a missing auth key", () => {
    expect(() =>
      parsePushSubscription({
        endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
        keys: { p256dh: TEST_PUSH_SUBSCRIPTION.keys.p256dh },
      }),
    ).toThrow(/auth/i);
  });
});
