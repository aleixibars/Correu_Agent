import { drizzle } from "drizzle-orm/pg-proxy";
import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import {
  createRetentionPurgeHandler,
  type RetentionPurgeJobData,
} from "./retention-purge";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "33333333-3333-3333-3333-333333333333";

/** `purgeExpiredMessageBodies` returns the id, tenant and thread, in that order. */
const createDb = (rows: unknown[][]) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows };
  });
  return { db, queries };
};

const job = (id: string): Job<RetentionPurgeJobData> =>
  ({ id, name: "retention-purge", data: {} }) as Job<RetentionPurgeJobData>;

describe("createRetentionPurgeHandler", () => {
  it("purges expired bodies and reports how many it emptied", async () => {
    const { db, queries } = createDb([
      ["55555555-5555-5555-5555-555555555555", TENANT_ID, THREAD_ID],
      ["66666666-6666-6666-6666-666666666666", TENANT_ID, THREAD_ID],
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await createRetentionPurgeHandler({ db })([job("job-1")]);

    expect(result).toEqual({ purged: 2 });
    expect(queries[0]!.sql).toContain('update "messages" set');
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2"));
    log.mockRestore();
  });

  it("purges once for a batch, not once per job", async () => {
    const { db, queries } = createDb([]);

    // The purge is one set-based statement, so several ticks that piled up are
    // still a single pass over the expired mail.
    await createRetentionPurgeHandler({ db })([job("job-1"), job("job-2")]);

    expect(queries).toHaveLength(1);
  });

  it("reports an empty purge without logging", async () => {
    const { db } = createDb([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      createRetentionPurgeHandler({ db })([job("job-1")]),
    ).resolves.toEqual({ purged: 0 });

    // Most days nothing expires; a daily "purged 0 messages" line is noise.
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
