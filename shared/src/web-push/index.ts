// Web Push for Urgent mail (context.md §5). Reached as
// `@correu-agent/shared/web-push`, not through the root barrel: `send.ts`
// imports the Node-only `web-push` package, and the barrel is imported by
// browser-bound `app/` code — same constraint as `./token-encryption`.

export { sendWebPush } from "./send";
export type {
  WebPushNotification,
  WebPushOptions,
  WebPushResult,
} from "./send";
export { parsePushSubscription } from "./subscription";
export type { PushSubscription } from "./subscription";
export { loadVapidConfig } from "./vapid";
export type { VapidConfig } from "./vapid";
