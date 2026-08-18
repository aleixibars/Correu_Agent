// Where the browsers that asked for Urgent notifications are kept (context.md
// §5). A subscription is opaque routing data — an endpoint plus the two keys
// the payload is encrypted with — so it is stored as it arrived and handed
// straight back to `sendWebPush`.

import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { pushSubscriptions } from "../db/schema";
import type { PushSubscription } from "./subscription";

export interface SavePushSubscriptionInput {
  tenantId: string;
  /** The dashboard user whose browser subscribed. */
  userId: string;
  subscription: PushSubscription;
}

/**
 * Stores a browser's subscription, replacing what was held for that endpoint.
 * A browser re-subscribes on its own — after a key rotation or a service worker
 * update — and hands back the same endpoint with fresh keys, so an upsert is
 * the normal path rather than the exception.
 */
export const savePushSubscription = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, userId, subscription }: SavePushSubscriptionInput,
): Promise<void> => {
  await db
    .insert(pushSubscriptions)
    .values({
      tenantId,
      userId,
      endpoint: subscription.endpoint,
      p256dhKey: subscription.keys.p256dh,
      authKey: subscription.keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        tenantId,
        // A shared desktop can hand the same browser to another user; the
        // subscription belongs to whoever enabled it last.
        userId,
        p256dhKey: subscription.keys.p256dh,
        authKey: subscription.keys.auth,
        updatedAt: new Date(),
      },
    });
};

/** Every browser to notify for a tenant. */
export const listPushSubscriptions = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  tenantId: string,
): Promise<PushSubscription[]> => {
  const rows = await db
    .select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dhKey,
      auth: pushSubscriptions.authKey,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.tenantId, tenantId));

  return rows.map(({ endpoint, p256dh, auth }) => ({
    endpoint,
    keys: { p256dh, auth },
  }));
};

export interface DeletePushSubscriptionInput {
  tenantId: string;
  endpoint: string;
}

/**
 * Forgets one browser — the user turned notifications off, or the push service
 * reported the subscription gone. Answers whether a row was really removed.
 */
export const deletePushSubscription = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  { tenantId, endpoint }: DeletePushSubscriptionInput,
): Promise<boolean> => {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.tenantId, tenantId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning({ id: pushSubscriptions.id });

  return deleted.length > 0;
};
