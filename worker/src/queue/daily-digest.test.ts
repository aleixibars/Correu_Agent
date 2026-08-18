import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Job } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIGEST_MODEL, type DigestMessagesClient } from "@correu-agent/shared/digest";
import {
  createDailyDigestHandler,
  type DailyDigestJobData,
} from "./daily-digest";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

/** The digest job fires at 05:00 UTC and covers the day that just ended. */
const NOW = new Date("2026-06-02T05:00:00.000Z");
const YESTERDAY = "2026-06-01";

const createClient = (text = "Resum del dia.") => {
  const create = vi.fn(
    async () =>
      ({
        model: DIGEST_MODEL,
        content: [{ type: "text", text }],
      }) as unknown as Anthropic.Message,
  );
  return { client: { create } as unknown as DigestMessagesClient, create };
};

/** In the column order the digest select asks for: id, subject, category, lastMessageAt. */
const threadRow = (id: string) => [
  id,
  "Assumpte",
  "comercial",
  `${YESTERDAY}T09:00:00.000Z`,
];

const createDb = ({
  tenantIds = [TENANT_A],
  threadsByTenant = { [TENANT_A]: [threadRow("t1")] } as Record<
    string,
    unknown[][]
  >,
}: {
  tenantIds?: string[];
  threadsByTenant?: Record<string, unknown[][]>;
} = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from "tenants"')) {
      return { rows: tenantIds.map((id) => [id]) };
    }
    if (sql.includes('from "threads"')) {
      const tenantId = params.find(
        (param) => typeof param === "string" && param in threadsByTenant,
      ) as string | undefined;
      return { rows: tenantId ? (threadsByTenant[tenantId] ?? []) : [] };
    }
    return { rows: [] };
  });
  return { db, queries };
};

const job = (id: string): Job<DailyDigestJobData> =>
  ({ id, name: "daily-digest", data: {} }) as Job<DailyDigestJobData>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDailyDigestHandler", () => {
  it("digests the day that just ended, for every tenant", async () => {
    const { db } = createDb();
    const { client, create } = createClient("Un fil comercial.");

    const result = await createDailyDigestHandler({ db, anthropic: client })([
      job("job-1"),
    ]);

    expect(result.day).toBe(YESTERDAY);
    expect(result.generated).toEqual([
      {
        tenantId: TENANT_A,
        day: YESTERDAY,
        threadCount: 1,
        summary: "Un fil comercial.",
        model: DIGEST_MODEL,
      },
    ]);
    expect(create).toHaveBeenCalledOnce();
  });

  it("skips a tenant whose day processed no mail", async () => {
    const { db } = createDb({
      tenantIds: [TENANT_A, TENANT_B],
      threadsByTenant: { [TENANT_A]: [threadRow("t1")], [TENANT_B]: [] },
    });
    const { client, create } = createClient();

    const result = await createDailyDigestHandler({ db, anthropic: client })([
      job("job-1"),
    ]);

    expect(result.skipped).toEqual([TENANT_B]);
    // A quiet tenant costs one grouped read and no model call.
    expect(create).toHaveBeenCalledOnce();
  });

  it("digests once for a batch, not once per job", async () => {
    const { db } = createDb();
    const { client, create } = createClient();

    // Ticks that piled up behind a slow run describe the same day.
    await createDailyDigestHandler({ db, anthropic: client })([
      job("job-1"),
      job("job-2"),
    ]);

    expect(create).toHaveBeenCalledOnce();
  });

  it("reports a tenant that failed without dropping the rest", async () => {
    const { db } = createDb({
      tenantIds: [TENANT_A, TENANT_B],
      threadsByTenant: {
        [TENANT_A]: [threadRow("t1")],
        [TENANT_B]: [threadRow("t2")],
      },
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockResolvedValue({
        model: DIGEST_MODEL,
        content: [{ type: "text", text: "Resum." }],
      } as unknown as Anthropic.Message);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createDailyDigestHandler({
      db,
      anthropic: { create } as unknown as DigestMessagesClient,
    })([job("job-1")]);

    expect(result.failed).toEqual([
      { tenantId: TENANT_A, error: "overloaded" },
    ]);
    expect(result.generated.map(({ tenantId }) => tenantId)).toEqual([TENANT_B]);
    error.mockRestore();
  });

  it("fails the job when every tenant failed", async () => {
    const { db } = createDb();
    const create = vi.fn().mockRejectedValue(new Error("expired key"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // Reporting success here would hide an expired API key behind an empty
    // result, once a day, forever.
    await expect(
      createDailyDigestHandler({
        db,
        anthropic: { create } as unknown as DigestMessagesClient,
      })([job("job-1")]),
    ).rejects.toThrow("expired key");
    error.mockRestore();
  });
});
