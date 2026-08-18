// The push client the pipeline talks to (context.md §5), bound to this
// deployment's VAPID credentials once at boot — the same shape as the Anthropic
// client the triage takes, so a caller can be handed a fake in tests.

import {
  sendWebPush,
  type WebPushNotification,
  type WebPushResult,
} from "./send";
import type { PushSubscription } from "./subscription";
import type { VapidConfig } from "./vapid";

export type WebPushSender = (
  subscription: PushSubscription,
  notification: WebPushNotification,
) => Promise<WebPushResult>;

export const createWebPushSender =
  (config: VapidConfig): WebPushSender =>
  (subscription, notification) =>
    sendWebPush(subscription, notification, config);
