import type Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import { DRAFT_MODEL, type DraftMessagesClient } from "./generate";
import { discardDraft, regenerateDraft } from "./reject-draft";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333";
const DRAFT_ID = "44444444-4444-4444-4444-444444444444";
const NEW_DRAFT_ID = "55555555-5555-5555-5555-555555555555";
const USER_ID = "66666666-6666-6666-6666-666666666666";

const NOW = new Date("2026-01-02T10:00:00.000Z");

const FEEDBACK = "Massa sec, i no prometis cap data.";
const OLD_BODY = "Bon dia,\n\nUs enviem el pressupost demà.";
const REPLY = { language: "ca", body: "Bon dia,\n\nUs enviem el pressupost." };

const createClient = (text = JSON.stringify(REPLY)) => {
  const create = vi.fn(
    async (_params: Anthropic.MessageCreateParamsNonStreaming) =>
      ({
        model: DRAFT_MODEL,
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      }) as unknown as Anthropic.Message,
  );
  return { client: { create } as unknown as DraftMessagesClient, create };
};

/** In the column order the draft-with-thread select asks for. */
const draftRow = ({
  category = "comercial" as string | null,
  inReplyToMessageId = MESSAGE_ID as string | null,
} = {}) => [DRAFT_ID, THREAD_ID, inReplyToMessageId, OLD_BODY, "Pressupost", category];

/** In the column order the message select asks for. */
const messageRow = () => [
  MESSAGE_ID,
  "inbound",
  "client@example.com",
  "Pressupost",
  "Voldríem un pressupost.",
  "Voldríem un pressupost",
  "<client@mail.example.com>",
  null,
  null,
];

const shape = (sql: string): string => {
  if (sql.startsWith("update")) return "claim draft";
  if (sql.includes('from "drafts"')) return "load draft";
  if (sql.includes('from "messages"')) return "load messages";
  if (sql.includes('insert into "drafts"')) return "store draft";
  if (sql.includes('insert into "audit_log_entries"')) return "audit";
  return "other";
};

const createDb = ({
  draft = draftRow() as unknown[] | null,
  messages = [messageRow()] as unknown[][],
  claimed = [[DRAFT_ID, THREAD_ID]] as unknown[][],
  inserted = [[NEW_DRAFT_ID]] as unknown[][],
} = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    switch (shape(sql)) {
      case "claim draft":
        return { rows: claimed };
      case "load draft":
        return { rows: draft ? [draft] : [] };
      case "load messages":
        return { rows: messages };
      case "store draft":
        return { rows: inserted };
      default:
        return { rows: [] };
    }
  });
  return { db, queries, shapes: () => queries.map(({ sql }) => shape(sql)) };
};

const queryOf = (
  queries: { sql: string; params: unknown[] }[],
  wanted: string,
): { sql: string; params: unknown[] } =>
  queries.find(({ sql }) => shape(sql) === wanted)!;

describe("discardDraft", () => {
  it("archives the rejected draft without answering, and audits who did it", async () => {
    const { db, queries, shapes } = createDb();

    await expect(
      discardDraft(db, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ draftId: DRAFT_ID, threadId: THREAD_ID });

    expect(shapes()).toEqual(["claim draft", "audit"]);
    const claim = queryOf(queries, "claim draft");
    expect(claim.params).toContain("discarded");
    // Only a draft still waiting for the user can be discarded — one already
    // approved or sent is not the user's to take back here.
    expect(claim.params).toContain("pending");

    const audit = queryOf(queries, "audit");
    expect(audit.params).toContain("draft_discarded");
    expect(audit.params).toContain(DRAFT_ID);
    // The audit trail's accountability anchor is the user who acted (context.md §7).
    expect(audit.params).toContain(USER_ID);
  });

  it("does nothing when the draft is no longer pending", async () => {
    // Two dashboard tabs, or a discard after an approval: whoever changed the
    // status first is the one that counts.
    const { db, shapes } = createDb({ claimed: [] });

    await expect(
      discardDraft(db, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
      }),
    ).resolves.toBeNull();
    expect(shapes()).toEqual(["claim draft"]);
  });
});

describe("regenerateDraft", () => {
  it("writes a new draft from the feedback, supersedes the old one and audits both", async () => {
    const { db, queries, shapes } = createDb();
    const { client, create } = createClient();

    await expect(
      regenerateDraft(db, client, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
        feedback: FEEDBACK,
        now: NOW,
      }),
    ).resolves.toEqual({
      threadId: THREAD_ID,
      draftId: NEW_DRAFT_ID,
      supersededDraftId: DRAFT_ID,
      language: "ca",
      model: DRAFT_MODEL,
    });

    expect(shapes()).toEqual([
      "load draft",
      "load messages",
      // The old draft is claimed only once the replacement text exists: a model
      // call that fails must leave the user the draft they still have.
      "claim draft",
      "store draft",
      "audit",
      "audit",
    ]);

    // The second call carries what was rejected and why (context.md §2).
    const prompt = String(create.mock.calls[0]![0].messages[0]!.content);
    expect(prompt).toContain(OLD_BODY);
    expect(prompt).toContain(FEEDBACK);

    const claim = queryOf(queries, "claim draft");
    expect(claim.params).toContain("superseded");
    expect(claim.params).toContain(FEEDBACK);

    const store = queryOf(queries, "store draft");
    expect(store.params).toContain(REPLY.body);
    expect(store.params).toContain(THREAD_ID);
    // The replacement answers the same message, so it threads the same way.
    expect(store.params).toContain(MESSAGE_ID);

    const [regenerated, generated] = queries.filter(
      ({ sql }) => shape(sql) === "audit",
    );
    expect(regenerated!.params).toContain("draft_regenerated");
    expect(regenerated!.params).toContain(DRAFT_ID);
    expect(regenerated!.params).toContain(USER_ID);
    // The two entries are linked instead of collapsed into one (context.md §7).
    expect(regenerated!.params.join(" ")).toContain(NEW_DRAFT_ID);
    expect(regenerated!.params.join(" ")).toContain(FEEDBACK);
    expect(generated!.params).toContain("draft_generated");
    expect(generated!.params).toContain(NEW_DRAFT_ID);
  });

  it("refuses a rejection with no instruction in it", async () => {
    // Regenerating from nothing would only pay Sonnet to write the same mail.
    const { db, shapes } = createDb();
    const { client, create } = createClient();

    await expect(
      regenerateDraft(db, client, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
        feedback: "   ",
      }),
    ).rejects.toThrow(/feedback/i);
    expect(create).not.toHaveBeenCalled();
    expect(shapes()).toEqual([]);
  });

  it("does not ask the model about a draft that is not pending", async () => {
    const { db, shapes } = createDb({ draft: null });
    const { client, create } = createClient();

    await expect(
      regenerateDraft(db, client, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
        feedback: FEEDBACK,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(shapes()).toEqual(["load draft"]);
  });

  it("writes nothing when the user answered the draft while the model wrote", async () => {
    // Approving in another tab wins: the draft that was approved is the one
    // being sent, and a replacement would take a slot it no longer holds.
    const { db, shapes } = createDb({ claimed: [] });
    const { client } = createClient();

    await expect(
      regenerateDraft(db, client, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
        feedback: FEEDBACK,
      }),
    ).resolves.toBeNull();
    expect(shapes()).toEqual(["load draft", "load messages", "claim draft"]);
  });

  it("leaves a thread triage never reached alone", async () => {
    // A draft cannot exist without a category, but the column is nullable and
    // the prompt is written in the register the category sets (context.md §4).
    const { db, shapes } = createDb({ draft: draftRow({ category: null }) });
    const { client, create } = createClient();

    await expect(
      regenerateDraft(db, client, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        userId: USER_ID,
        feedback: FEEDBACK,
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(shapes()).toEqual(["load draft"]);
  });
});
