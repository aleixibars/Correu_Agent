// The one active notification in the product (context.md §5): a thread just
// classified as Urgent is pushed to the browsers of the tenant that owns it.
// Everything else waits for the daily digest, and nothing is ever mailed back
// into the mailbox being watched.

import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { messages, threads } from "../db/schema";
import type { WebPushNotification } from "./send";
import type { WebPushSender } from "./sender";
import { deletePushSubscription, listPushSubscriptions } from "./store";

/** Notification title, in Catalan like the rest of the dashboard (context.md §11). */
export const URGENT_TITLE = "Correu urgent";

/** Stands in for the subject line of mail that arrived without one. */
export const NO_SUBJECT_LABEL = "(sense assumpte)";

/** Where clicking the notification lands: the thread's page on the dashboard. */
export const urgentThreadPath = (threadId: string): string =>
  `/fils/${threadId}`;

export interface NotifyUrgentThreadInput {
  tenantId: string;
  threadId: string;
}

export interface UrgentNotificationResult {
  sent: number;
  /** Subscriptions the push service reported as gone; they have been deleted. */
  expired: number;
}

const NOTHING_TO_SEND: UrgentNotificationResult = { sent: 0, expired: 0 };

/**
 * Pushes one Urgent thread to every browser subscribed for its tenant, and
 * forgets the subscriptions the push service reports as gone.
 *
 * A failing send is logged and the remaining browsers are still notified: the
 * classification this belongs to is already stored, so nothing here is worth
 * failing the job over.
 */
export const notifyUrgentThread = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  send: WebPushSender,
  { tenantId, threadId }: NotifyUrgentThreadInput,
): Promise<UrgentNotificationResult> => {
  // Asked first: with no browser subscribed there is nothing to describe.
  const subscriptions = await listPushSubscriptions(db, tenantId);
  if (subscriptions.length === 0) return NOTHING_TO_SEND;

  const [thread] = await db
    .select({ subject: threads.subject, fromAddress: messages.fromAddress })
    .from(threads)
    // Left join: a thread whose mail is not stored yet still gets notified, on
    // its subject alone. Inbound only — the notification names who wrote in,
    // and a reply this product sent is not that.
    .leftJoin(
      messages,
      and(eq(messages.threadId, threads.id), eq(messages.direction, "inbound")),
    )
    .where(and(eq(threads.id, threadId), eq(threads.tenantId, tenantId)))
    // The newest mail is what made the thread urgent. Spelled out rather than
    // `desc()`: Postgres sorts nulls first on a descending order, which would
    // pick a message the provider gave no date for over the real newest one.
    .orderBy(sql`${messages.sentAt} desc nulls last`)
    .limit(1);

  if (!thread) return NOTHING_TO_SEND;

  const subject = thread.subject?.trim() || NO_SUBJECT_LABEL;
  const notification: WebPushNotification = {
    title: URGENT_TITLE,
    body: thread.fromAddress ? `${thread.fromAddress}: ${subject}` : subject,
    url: urgentThreadPath(threadId),
  };

  let sent = 0;
  let expired = 0;

  for (const subscription of subscriptions) {
    try {
      const result = await send(subscription, notification);
      if (result.expired) {
        expired += 1;
        await deletePushSubscription(db, {
          tenantId,
          endpoint: subscription.endpoint,
        });
      } else {
        sent += 1;
      }
    } catch (error) {
      console.error(
        `Pushing the urgent thread ${threadId} to ${subscription.endpoint} failed:`,
        error,
      );
    }
  }

  return { sent, expired };
};
