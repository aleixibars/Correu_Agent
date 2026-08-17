import { beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import {
  DEFAULT_TTL_SECONDS,
  sendWebPush,
  serializeNotification,
} from "./send";
import { loadVapidConfig } from "./vapid";
import { TEST_PUSH_SUBSCRIPTION, TEST_VAPID_ENV } from "./test-fixtures";

// The push service itself is out of reach in tests, so what is exercised here is
// our own mapping: payload shape, request options, and outcome handling. The
// signing and encryption behind `sendNotification` belongs to `web-push`.
vi.mock("web-push", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: typeof webpush };
  return {
    default: { ...actual.default, sendNotification: vi.fn() },
  };
});

const sendNotification = vi.mocked(webpush.sendNotification);
const config = loadVapidConfig(TEST_VAPID_ENV);
const notification = {
  title: "Correu urgent",
  body: "Client X demana resposta immediata",
  url: "/fils/42",
};
const send = (options?: Parameters<typeof sendWebPush>[3]) =>
  sendWebPush(TEST_PUSH_SUBSCRIPTION, notification, config, options);

const optionsOfLastCall = () => sendNotification.mock.calls.at(-1)?.[2];

const pushError = (statusCode: number) =>
  new webpush.WebPushError(
    "push service said no",
    statusCode,
    {},
    "",
    TEST_PUSH_SUBSCRIPTION.endpoint,
  );

beforeEach(() => {
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
});

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

describe("sendWebPush", () => {
  it("reports the push service status code on success", async () => {
    await expect(send()).resolves.toEqual({ statusCode: 201, expired: false });
  });

  it("sends the serialised notification to the subscription", async () => {
    await send();

    expect(sendNotification).toHaveBeenCalledWith(
      TEST_PUSH_SUBSCRIPTION,
      serializeNotification(notification),
      expect.anything(),
    );
  });

  it("signs the request with the VAPID details and aes128gcm encoding", async () => {
    await send();

    expect(optionsOfLastCall()).toMatchObject({
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
      contentEncoding: "aes128gcm",
    });
  });

  it("defaults to a high-urgency, short-lived notification", async () => {
    await send();

    expect(optionsOfLastCall()).toMatchObject({
      TTL: DEFAULT_TTL_SECONDS,
      urgency: "high",
    });
  });

  it("allows overriding TTL and urgency", async () => {
    await send({ ttlSeconds: 60, urgency: "normal" });

    expect(optionsOfLastCall()).toMatchObject({ TTL: 60, urgency: "normal" });
  });

  it("reports a 410 subscription as expired instead of throwing", async () => {
    sendNotification.mockRejectedValue(pushError(410));

    await expect(send()).resolves.toEqual({ statusCode: 410, expired: true });
  });

  it("reports a 404 subscription as expired", async () => {
    sendNotification.mockRejectedValue(pushError(404));

    await expect(send()).resolves.toEqual({ statusCode: 404, expired: true });
  });

  it("rethrows other push service failures", async () => {
    sendNotification.mockRejectedValue(pushError(500));

    await expect(send()).rejects.toThrow(/push service said no/);
  });
});
