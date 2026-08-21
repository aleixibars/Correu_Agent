import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  buildAuditLogEntry,
  type AuditAction,
  type AuditEvent,
} from "./events";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const DRAFT_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";
const MESSAGE_ID = "55555555-5555-5555-5555-555555555555";

const SYSTEM = { type: "system" } as const;
const USER = { type: "user", userId: USER_ID } as const;

/**
 * One event per action, so a new action cannot be added to `AUDIT_ACTIONS`
 * without the whole suite below covering it too.
 */
const EVENTS: { [A in AuditAction]: Extract<AuditEvent, { action: A }> } = {
  mail_received: {
    action: "mail_received",
    tenantId: TENANT_ID,
    actor: SYSTEM,
    threadId: THREAD_ID,
    providerMessageIds: ["gmail-message-1"],
    threadCreated: true,
  },
  thread_classified: {
    action: "thread_classified",
    tenantId: TENANT_ID,
    actor: SYSTEM,
    threadId: THREAD_ID,
    previousCategory: null,
    category: "urgent",
    model: "claude-haiku-4-5-20251001",
  },
  draft_generated: {
    action: "draft_generated",
    tenantId: TENANT_ID,
    actor: SYSTEM,
    threadId: THREAD_ID,
    draftId: DRAFT_ID,
    model: "claude-sonnet-5",
    language: "ca",
    autoReply: false,
  },
  draft_approved: {
    action: "draft_approved",
    tenantId: TENANT_ID,
    actor: USER,
    threadId: THREAD_ID,
    draftId: DRAFT_ID,
  },
  draft_discarded: {
    action: "draft_discarded",
    tenantId: TENANT_ID,
    actor: USER,
    threadId: THREAD_ID,
    draftId: DRAFT_ID,
  },
  draft_regenerated: {
    action: "draft_regenerated",
    tenantId: TENANT_ID,
    actor: USER,
    threadId: THREAD_ID,
    draftId: DRAFT_ID,
    replacementDraftId: "66666666-6666-6666-6666-666666666666",
    feedback: "Massa formal, escurça-ho.",
  },
  draft_sent: {
    action: "draft_sent",
    tenantId: TENANT_ID,
    actor: USER,
    threadId: THREAD_ID,
    draftId: DRAFT_ID,
    sentMessageId: MESSAGE_ID,
  },
  auto_reply_sent: {
    action: "auto_reply_sent",
    tenantId: TENANT_ID,
    actor: SYSTEM,
    threadId: THREAD_ID,
    draftId: DRAFT_ID,
    category: "comercial",
    sentMessageId: MESSAGE_ID,
  },
  auto_reply_rule_changed: {
    action: "auto_reply_rule_changed",
    tenantId: TENANT_ID,
    actor: USER,
    category: "comercial",
    previousEnabled: false,
    enabled: true,
    instructions: null,
    previousInstructions: null,
  },
  thread_auto_discarded: {
    action: "thread_auto_discarded",
    tenantId: TENANT_ID,
    actor: SYSTEM,
    threadId: THREAD_ID,
    draftId: DRAFT_ID,
    category: "newsletter",
  },
  auto_discard_rule_changed: {
    action: "auto_discard_rule_changed",
    tenantId: TENANT_ID,
    actor: USER,
    category: "newsletter",
    previousEnabled: true,
    enabled: false,
  },
};

/** The actions that belong to a thread; the rest are tenant-wide configuration. */
const THREAD_ACTIONS = AUDIT_ACTIONS.filter(
  (action) =>
    action !== "auto_reply_rule_changed" &&
    action !== "auto_discard_rule_changed",
);

/** Every action's `metadata.before` / `metadata.after`, i.e. the transition it records. */
const TRANSITIONS: Record<
  AuditAction,
  { before: unknown; after: unknown }
> = {
  mail_received: {
    before: undefined,
    after: { providerMessageIds: ["gmail-message-1"] },
  },
  thread_classified: {
    before: { category: null },
    after: { category: "urgent" },
  },
  draft_generated: { before: undefined, after: { status: "pending" } },
  draft_approved: {
    before: { status: "pending" },
    after: { status: "approved" },
  },
  draft_discarded: {
    before: { status: "pending" },
    after: { status: "discarded" },
  },
  draft_regenerated: {
    before: { status: "pending" },
    after: { status: "superseded" },
  },
  draft_sent: { before: { status: "approved" }, after: { status: "sent" } },
  auto_reply_sent: {
    before: { status: "pending" },
    after: { status: "sent" },
  },
  auto_reply_rule_changed: {
    before: { enabled: false, instructions: null },
    after: { enabled: true, instructions: null },
  },
  thread_auto_discarded: {
    before: undefined,
    after: { status: "discarded" },
  },
  auto_discard_rule_changed: {
    before: { enabled: true },
    after: { enabled: false },
  },
};

const metadataOf = (event: AuditEvent): Record<string, unknown> =>
  buildAuditLogEntry(event).metadata as Record<string, unknown>;

describe("buildAuditLogEntry", () => {
  it.each(AUDIT_ACTIONS)("records %s against its tenant", (action) => {
    const entry = buildAuditLogEntry(EVENTS[action]);

    expect(entry.action).toBe(action);
    expect(entry.tenantId).toBe(TENANT_ID);
  });

  it.each(THREAD_ACTIONS)("records %s against its thread", (action) => {
    // Every draft action carries its thread too, so one query by thread returns
    // the whole "why was this mail sent" trail (context.md §7).
    expect(buildAuditLogEntry(EVENTS[action]).threadId).toBe(THREAD_ID);
  });

  it("records an auto-reply switch against no thread", () => {
    // Turning a category on is what permits *later* mail to go out unapproved,
    // so it belongs to the tenant, not to any one thread (context.md §2).
    expect(
      buildAuditLogEntry(EVENTS.auto_reply_rule_changed).threadId,
    ).toBeNull();
  });

  it("records an auto-discard switch against no thread", () => {
    // Turning a category on is what closes out *later* mail with nobody
    // looking at it, so it belongs to the tenant, not to any one thread.
    expect(
      buildAuditLogEntry(EVENTS.auto_discard_rule_changed).threadId,
    ).toBeNull();
  });

  it.each(AUDIT_ACTIONS)("records the before/after state of %s", (action) => {
    const metadata = metadataOf(EVENTS[action]);
    const { before, after } = TRANSITIONS[action];

    expect(metadata.after).toEqual(after);
    if (before === undefined) {
      // A freshly generated draft has no previous state to report.
      expect(metadata).not.toHaveProperty("before");
    } else {
      expect(metadata.before).toEqual(before);
    }
  });

  it.each(AUDIT_ACTIONS)("attributes %s to the acting user or the system", (action) => {
    const event = EVENTS[action];
    const entry = buildAuditLogEntry(event);

    expect(entry.actorType).toBe(event.actor.type);
    expect(entry.actorUserId).toBe(
      event.actor.type === "user" ? USER_ID : null,
    );
  });

  it("links draft actions to the draft, and thread-only actions to no draft", () => {
    expect(buildAuditLogEntry(EVENTS.draft_approved).draftId).toBe(DRAFT_ID);
    expect(buildAuditLogEntry(EVENTS.thread_classified).draftId).toBeNull();
  });

  it("reports the previous category when a thread is re-triaged", () => {
    const metadata = metadataOf({
      ...EVENTS.thread_classified,
      previousCategory: "comercial",
      category: "urgent",
    });

    expect(metadata.before).toEqual({ category: "comercial" });
    expect(metadata.after).toEqual({ category: "urgent" });
  });

  it("records the model behind a classification and a generated draft", () => {
    expect(metadataOf(EVENTS.thread_classified).model).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(metadataOf(EVENTS.draft_generated).model).toBe("claude-sonnet-5");
    expect(metadataOf(EVENTS.draft_generated).autoReply).toBe(false);
  });

  it("records the text the user edited before approving", () => {
    const metadata = metadataOf({
      ...EVENTS.draft_approved,
      edit: { from: "Bon dia", to: "Bon dia i gràcies" },
    });

    expect(metadata.before).toEqual({ status: "pending", body: "Bon dia" });
    expect(metadata.after).toEqual({
      status: "approved",
      body: "Bon dia i gràcies",
    });
  });

  it("omits the body when the user approved the draft untouched", () => {
    const metadata = metadataOf(EVENTS.draft_approved);

    expect(metadata.before).not.toHaveProperty("body");
    expect(metadata.after).not.toHaveProperty("body");
  });

  it("records the rejection feedback and the draft that replaced this one", () => {
    const metadata = metadataOf(EVENTS.draft_regenerated);

    expect(metadata.feedback).toBe("Massa formal, escurça-ho.");
    expect(metadata.replacementDraftId).toBe(
      "66666666-6666-6666-6666-666666666666",
    );
  });

  it("records which sent message a send produced", () => {
    expect(metadataOf(EVENTS.draft_sent).sentMessageId).toBe(MESSAGE_ID);
    expect(metadataOf(EVENTS.auto_reply_sent).sentMessageId).toBe(MESSAGE_ID);
  });

  it("records which category's switch was moved, and to what", () => {
    const metadata = metadataOf({
      ...EVENTS.auto_reply_rule_changed,
      instructions: "Respon en to proper.",
    });

    expect(metadata.category).toBe("comercial");
    expect(metadata.before).toEqual({ enabled: false, instructions: null });
    expect(metadata.after).toEqual({
      enabled: true,
      instructions: "Respon en to proper.",
    });
  });

  it("records a rewrite of the guidance with the switch left alone", () => {
    // The switch stays on either side, so the guidance is the only thing that
    // says what changed about the mail this rule sends unapproved.
    const metadata = metadataOf({
      ...EVENTS.auto_reply_rule_changed,
      previousEnabled: true,
      enabled: true,
      previousInstructions: "Respon en to proper.",
      instructions: "Ofereix sempre un descompte.",
    });

    expect(metadata.before).toEqual({
      enabled: true,
      instructions: "Respon en to proper.",
    });
    expect(metadata.after).toEqual({
      enabled: true,
      instructions: "Ofereix sempre un descompte.",
    });
  });

  it("records which category's rule fired an auto-reply", () => {
    // The whole point of the granular auto-reply switch (context.md §2) is being
    // able to answer which rule sent a mail nobody approved.
    expect(metadataOf(EVENTS.auto_reply_sent).category).toBe("comercial");
  });

  it("records which category's rule discarded a thread automatically", () => {
    // The whole point of the granular auto-discard switch is being able to
    // answer which rule closed out a thread nobody ever saw.
    expect(metadataOf(EVENTS.thread_auto_discarded).category).toBe(
      "newsletter",
    );
    expect(buildAuditLogEntry(EVENTS.thread_auto_discarded).draftId).toBe(
      DRAFT_ID,
    );
  });

  it("lists every action the events declare", () => {
    // `EVENTS` is keyed by `AuditAction`, which is the event union itself, so an
    // event left out of `AUDIT_ACTIONS` surfaces here instead of quietly
    // skipping every per-action case above.
    expect([...AUDIT_ACTIONS].sort()).toEqual(Object.keys(EVENTS).sort());
  });

  it("leaves created_at to the database unless the caller knows when it happened", () => {
    expect(buildAuditLogEntry(EVENTS.draft_sent)).not.toHaveProperty("createdAt");

    const occurredAt = new Date("2026-02-03T10:00:00.000Z");
    expect(
      buildAuditLogEntry({ ...EVENTS.draft_sent, occurredAt }).createdAt,
    ).toBe(occurredAt);
  });
});
