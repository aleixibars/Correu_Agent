// Web Push for Urgent mail (context.md §5). Reached as
// `@correu-agent/shared/web-push`, not through the root barrel: `send.ts`
// imports the Node-only `web-push` package and the store reaches drizzle, while
// the barrel is imported by browser-bound `app/` code — same constraint as
// `./token-encryption`.

export { sendWebPush } from "./send";
export type {
  WebPushNotification,
  WebPushOptions,
  WebPushResult,
} from "./send";
export { createWebPushSender } from "./sender";
export type { WebPushSender } from "./sender";
export {
  deletePushSubscription,
  listPushSubscriptions,
  savePushSubscription,
} from "./store";
export type {
  DeletePushSubscriptionInput,
  SavePushSubscriptionInput,
} from "./store";
export { parsePushSubscription } from "./subscription";
export type { PushSubscription } from "./subscription";
export {
  NO_SUBJECT_LABEL,
  URGENT_NOTIFICATION_PATH,
  URGENT_TITLE,
  notifyUrgentThread,
} from "./urgent";
export type {
  NotifyUrgentThreadInput,
  UrgentNotificationResult,
} from "./urgent";
export { loadVapidConfig } from "./vapid";
export type { VapidConfig } from "./vapid";
