import webpush from "web-push";
import type { PushSubscription } from "./subscription";
import type { VapidConfig } from "./vapid";

// Web Push delivery for active notifications (context.md §5). Urgent mail is the
// only sender today; everything else is covered by the in-dashboard digest.

/** What the dashboard service worker renders. Kept small — a push payload is size-capped. */
export type WebPushNotification = {
  title: string;
  body: string;
  /** Dashboard path to open on click, e.g. `/fils/42`. */
  url?: string;
};

export type WebPushOptions = {
  ttlSeconds?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
};

export type WebPushHeaders = {
  /** `vapid t=<signed JWT>, k=<public key>` */
  Authorization: string;
  "Content-Encoding": string;
  "Content-Type": string;
  "Content-Length": number;
  TTL: number;
  Urgency: string;
};

export type WebPushRequest = {
  endpoint: string;
  headers: WebPushHeaders;
  body: Buffer;
};

/**
 * An urgent notification is worthless once stale, so the push service should not
 * hold it for long if the desktop browser is offline.
 */
export const DEFAULT_TTL_SECONDS = 600;

const requestOptions = (config: VapidConfig, options: WebPushOptions) => ({
  vapidDetails: {
    subject: config.subject,
    publicKey: config.publicKey,
    privateKey: config.privateKey,
  },
  contentEncoding: "aes128gcm" as const,
  TTL: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  urgency: options.urgency ?? ("high" as const),
});

export const serializeNotification = (
  notification: WebPushNotification,
): string =>
  JSON.stringify({
    title: notification.title,
    body: notification.body,
    ...(notification.url === undefined ? {} : { url: notification.url }),
  });

/**
 * Builds the signed, encrypted request for a subscription without sending it —
 * the seam `sendWebPush` goes through, and what the tests assert on.
 */
export const buildWebPushRequest = (
  subscription: PushSubscription,
  notification: WebPushNotification,
  config: VapidConfig,
  options: WebPushOptions = {},
): WebPushRequest => {
  const details = webpush.generateRequestDetails(
    subscription,
    serializeNotification(notification),
    requestOptions(config, options),
  );

  return {
    endpoint: details.endpoint,
    headers: details.headers as unknown as WebPushHeaders,
    body: details.body as Buffer,
  };
};

export type WebPushResult = {
  statusCode: number;
  /** True when the push service says the subscription is gone (404/410) and should be deleted. */
  expired: boolean;
};

/** Sends a notification, mapping a dead subscription to a result instead of a throw. */
export const sendWebPush = async (
  subscription: PushSubscription,
  notification: WebPushNotification,
  config: VapidConfig,
  options: WebPushOptions = {},
): Promise<WebPushResult> => {
  try {
    const response = await webpush.sendNotification(
      subscription,
      serializeNotification(notification),
      requestOptions(config, options),
    );
    return { statusCode: response.statusCode, expired: false };
  } catch (error) {
    if (
      error instanceof webpush.WebPushError &&
      (error.statusCode === 404 || error.statusCode === 410)
    ) {
      return { statusCode: error.statusCode, expired: true };
    }
    throw error;
  }
};
