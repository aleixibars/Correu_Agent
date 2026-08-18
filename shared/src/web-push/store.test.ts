import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import {
  deletePushSubscription,
  listPushSubscriptions,
  savePushSubscription,
} from "./store";
import { TEST_PUSH_SUBSCRIPTION } from "./test-fixtures";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const SUBSCRIPTION_ID = "44444444-4444-4444-4444-444444444444";

/**
 * Drizzle's proxy driver builds the statement for real and hands it back
 * instead of reaching Neon, so the test asserts on what would be written.
 */
const createDb = (rows: unknown[][] = [[SUBSCRIPTION_ID]]) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows };
  });
  return { db, queries };
};

describe("savePushSubscription", () => {
  const save = (db: ReturnType<typeof createDb>["db"]) =>
    savePushSubscription(db, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      subscription: TEST_PUSH_SUBSCRIPTION,
    });

  it("stores the endpoint and both keys against the tenant and user", async () => {
    const { db, queries } = createDb();

    await save(db);

    const { sql, params } = queries[0]!;
    expect(sql).toContain('insert into "push_subscriptions"');
    expect(params).toEqual(
      expect.arrayContaining([
        TENANT_ID,
        USER_ID,
        TEST_PUSH_SUBSCRIPTION.endpoint,
        TEST_PUSH_SUBSCRIPTION.keys.p256dh,
        TEST_PUSH_SUBSCRIPTION.keys.auth,
      ]),
    );
  });

  // The browser re-subscribes on its own (key rotation, a service worker
  // update), handing back the same endpoint with fresh keys.
  it("refreshes the row instead of failing when the browser subscribes again", async () => {
    const { db, queries } = createDb();

    await save(db);

    const { sql } = queries[0]!;
    expect(sql).toContain("on conflict");
    const update = sql.slice(sql.indexOf("do update set"));
    expect(update).toContain('"p256dh_key"');
    expect(update).toContain('"auth_key"');
    expect(update).toContain('"user_id"');
  });
});

describe("listPushSubscriptions", () => {
  it("returns the tenant's subscriptions in the shape the sender takes", async () => {
    const { db, queries } = createDb([
      [
        TEST_PUSH_SUBSCRIPTION.endpoint,
        TEST_PUSH_SUBSCRIPTION.keys.p256dh,
        TEST_PUSH_SUBSCRIPTION.keys.auth,
      ],
    ]);

    await expect(listPushSubscriptions(db, TENANT_ID)).resolves.toEqual([
      {
        endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
        keys: {
          p256dh: TEST_PUSH_SUBSCRIPTION.keys.p256dh,
          auth: TEST_PUSH_SUBSCRIPTION.keys.auth,
        },
      },
    ]);

    const { sql, params } = queries[0]!;
    expect(sql).toContain('from "push_subscriptions"');
    expect(sql).toContain('"tenant_id" = $1');
    expect(params).toEqual([TENANT_ID]);
  });
});

describe("deletePushSubscription", () => {
  it("deletes only the named endpoint, scoped to the tenant", async () => {
    const { db, queries } = createDb();

    await expect(
      deletePushSubscription(db, {
        tenantId: TENANT_ID,
        endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
      }),
    ).resolves.toBe(true);

    const { sql, params } = queries[0]!;
    expect(sql).toContain('delete from "push_subscriptions"');
    expect(params).toEqual([TENANT_ID, TEST_PUSH_SUBSCRIPTION.endpoint]);
  });

  it("reports that nothing was deleted when the endpoint is unknown", async () => {
    const { db } = createDb([]);

    await expect(
      deletePushSubscription(db, {
        tenantId: TENANT_ID,
        endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
      }),
    ).resolves.toBe(false);
  });
});
