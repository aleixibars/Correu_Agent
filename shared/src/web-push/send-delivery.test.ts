import { beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { sendWebPush } from "./send";
import { loadVapidConfig } from "./vapid";
import { TEST_PUSH_SUBSCRIPTION, TEST_VAPID_ENV } from "./test-fixtures";

// The push service itself is out of reach in tests, so only the outcome mapping
// around it is exercised here; header/payload construction is covered by
// `send.test.ts` against the real web-push encoder.
vi.mock("web-push", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: typeof webpush };
  return {
    default: { ...actual.default, sendNotification: vi.fn() },
  };
});

const sendNotification = vi.mocked(webpush.sendNotification);
const config = loadVapidConfig(TEST_VAPID_ENV);
const notification = { title: "Correu urgent", body: "Resposta immediata" };
const send = () => sendWebPush(TEST_PUSH_SUBSCRIPTION, notification, config);

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
});

describe("sendWebPush", () => {
  it("reports the push service status code on success", async () => {
    sendNotification.mockResolvedValue({
      statusCode: 201,
      body: "",
      headers: {},
    });

    await expect(send()).resolves.toEqual({ statusCode: 201, expired: false });
  });

  it("sends the notification with the VAPID details and aes128gcm encoding", async () => {
    sendNotification.mockResolvedValue({
      statusCode: 201,
      body: "",
      headers: {},
    });

    await send();

    expect(sendNotification).toHaveBeenCalledWith(
      TEST_PUSH_SUBSCRIPTION,
      JSON.stringify(notification),
      expect.objectContaining({
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
        contentEncoding: "aes128gcm",
        urgency: "high",
      }),
    );
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
