import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { saveDraftEdit } from "./save-draft-edit";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const DRAFT_ID = "44444444-4444-4444-4444-444444444444";

const NOW = new Date("2026-01-02T10:00:00.000Z");

const BODY = "Bon dia,\n\nUs enviem el pressupost dilluns.";

const createDb = ({ saved = [[DRAFT_ID, THREAD_ID]] as unknown[][] } = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: saved };
  });
  return { db, queries };
};

describe("saveDraftEdit", () => {
  it("keeps the text the reviewer is writing without touching the draft's own body", async () => {
    const { db, queries } = createDb();

    await expect(
      saveDraftEdit(db, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        body: BODY,
        now: NOW,
      }),
    ).resolves.toEqual({ draftId: DRAFT_ID, threadId: THREAD_ID });

    expect(queries).toHaveLength(1);
    const [update] = queries;
    expect(update.sql).toContain('update "drafts" set "edited_body"');
    // The model's own text stays where the audit trail reads it from.
    expect(update.sql).not.toContain('"body" =');
    expect(update.params).toContain(BODY);
  });

  // Two tabs, or a timer that fires while the approval is on its way: the draft
  // is no longer the reviewer's to edit, so the autosave writes nothing.
  it("only writes while the draft is still waiting for the reviewer", async () => {
    const { db, queries } = createDb();

    await saveDraftEdit(db, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      body: BODY,
      now: NOW,
    });

    expect(queries[0].sql).toContain('"status" = $');
    expect(queries[0].params).toContain("pending");
  });

  it("is scoped to the tenant the session belongs to", async () => {
    const { db, queries } = createDb();

    await saveDraftEdit(db, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      body: BODY,
      now: NOW,
    });

    expect(queries[0].params).toContain(TENANT_ID);
  });

  it("answers null when the draft was already approved, discarded or regenerated", async () => {
    const { db } = createDb({ saved: [] });

    await expect(
      saveDraftEdit(db, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        body: BODY,
        now: NOW,
      }),
    ).resolves.toBeNull();
  });

  // An empty field is not an edit worth keeping: it would leave the reviewer
  // with nothing where the model's text used to be when they come back.
  it("refuses to store an empty edit", async () => {
    const { db, queries } = createDb();

    await expect(
      saveDraftEdit(db, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        body: "   \n ",
        now: NOW,
      }),
    ).rejects.toThrow(/empty/i);

    expect(queries).toHaveLength(0);
  });

  it("records no audit entry: nothing about the draft has been decided yet", async () => {
    const { db, queries } = createDb();

    await saveDraftEdit(db, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      body: BODY,
      now: NOW,
    });

    expect(
      queries.some(({ sql }) => sql.includes('insert into "audit_log_entries"')),
    ).toBe(false);
  });
});
