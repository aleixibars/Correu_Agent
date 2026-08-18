import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import type { WebPushSender } from "./sender";
import { TEST_PUSH_SUBSCRIPTION } from "./test-fixtures";
import { NO_SUBJECT_LABEL, URGENT_TITLE, notifyUrgentThread } from "./urgent";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const SUBSCRIPTION_ID = "44444444-4444-4444-4444-444444444444";

/** In the column order the subscription select asks for. */
const subscriptionRow = (
  endpoint: string = TEST_PUSH_SUBSCRIPTION.endpoint,
) => [
  endpoint,
  TEST_PUSH_SUBSCRIPTION.keys.p256dh,
  TEST_PUSH_SUBSCRIPTION.keys.auth,
];

/** In the column order the thread select asks for: subject, fromAddress. */
const threadRow = (subject: string | null = "Servidor caigut") => [
  subject,
  "client@example.com",
];

const createDb = ({
  subscriptions = [subscriptionRow()],
  thread = threadRow(),
}: { subscriptions?: unknown[][]; thread?: unknown[] | null } = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "push_subscriptions"')) return { rows: subscriptions };
    if (sql.includes('from "threads"')) return { rows: thread ? [thread] : [] };
    if (sql.includes('delete from "push_subscriptions"'))
      return { rows: [[SUBSCRIPTION_ID]] };
    return { rows: [] };
  });
  return { db, queries };
};

const createSender = () =>
  vi.fn<WebPushSender>(async () => ({ statusCode: 201, expired: false }));

const notify = (
  db: ReturnType<typeof createDb>["db"],
  sender: ReturnType<typeof createSender>,
) => notifyUrgentThread(db, sender, { tenantId: TENANT_ID, threadId: THREAD_ID });

describe("notifyUrgentThread", () => {
  it("pushes the thread's sender and subject to every subscribed browser", async () => {
    const { db } = createDb();
    const sender = createSender();

    await expect(notify(db, sender)).resolves.toEqual({ sent: 1, expired: 0 });

    expect(sender).toHaveBeenCalledWith(
      {
        endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
        keys: {
          p256dh: TEST_PUSH_SUBSCRIPTION.keys.p256dh,
          auth: TEST_PUSH_SUBSCRIPTION.keys.auth,
        },
      },
      {
        title: URGENT_TITLE,
        body: "client@example.com: Servidor caigut",
        url: `/fils/${THREAD_ID}`,
      },
    );
  });

  it("names mail with no subject rather than pushing an empty line", async () => {
    const { db } = createDb({ thread: threadRow(null) });
    const sender = createSender();

    await notify(db, sender);

    expect(sender.mock.calls[0]?.[1].body).toBe(
      `client@example.com: ${NO_SUBJECT_LABEL}`,
    );
  });

  it("reads the thread scoped to its tenant", async () => {
    const { db, queries } = createDb();

    await notify(db, createSender());

    const threadQuery = queries.find(({ sql }) => sql.includes('from "threads"'))!;
    expect(threadQuery.params).toEqual(
      expect.arrayContaining([TENANT_ID, THREAD_ID]),
    );
  });

  it("does not read the thread when nobody is subscribed", async () => {
    const { db, queries } = createDb({ subscriptions: [] });
    const sender = createSender();

    await expect(notify(db, sender)).resolves.toEqual({ sent: 0, expired: 0 });

    expect(sender).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => sql.includes('from "threads"'))).toBe(false);
  });

  it("sends nothing when the thread is gone", async () => {
    const { db } = createDb({ thread: null });
    const sender = createSender();

    await expect(notify(db, sender)).resolves.toEqual({ sent: 0, expired: 0 });
    expect(sender).not.toHaveBeenCalled();
  });

  it("forgets a subscription the push service reports as gone", async () => {
    const { db, queries } = createDb();
    const sender = createSender();
    sender.mockResolvedValue({ statusCode: 410, expired: true });

    await expect(notify(db, sender)).resolves.toEqual({ sent: 0, expired: 1 });

    const deletion = queries.find(({ sql }) =>
      sql.includes('delete from "push_subscriptions"'),
    )!;
    expect(deletion.params).toEqual([
      TENANT_ID,
      TEST_PUSH_SUBSCRIPTION.endpoint,
    ]);
  });

  // One unreachable push service must not silence the browsers behind it, and
  // the classification it belongs to is already stored either way.
  it("keeps notifying the other browsers when one send throws", async () => {
    const { db } = createDb({
      subscriptions: [subscriptionRow(), subscriptionRow("https://push.example/2")],
    });
    const sender = createSender();
    sender.mockRejectedValueOnce(new Error("push service unreachable"));

    await expect(notify(db, sender)).resolves.toEqual({ sent: 1, expired: 0 });
    expect(sender).toHaveBeenCalledTimes(2);
  });
});
