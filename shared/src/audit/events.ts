// Audit trail for every non-bookkeeping action (context.md §7): classification,
// draft generated/approved/discarded/regenerated, mail actually sent and the
// auto-reply switches that let mail go out unapproved in the first place. The
// question it has to answer for a real client is "why was this mail sent", so an
// entry says who acted, on what, and what the state was either side of the act.

import type { DraftStatus, NewAuditLogEntry } from "../db/schema";
import type { TriageCategory } from "../triage/taxonomy";

/** The pipeline itself acted — triage, draft generation, an auto-reply rule. */
export type SystemActor = { type: "system" };
/** A dashboard user acted; `userId` is the audit trail's accountability anchor. */
export type UserActor = { type: "user"; userId: string };
export type AuditActor = SystemActor | UserActor;

/** What every entry carries, whatever it is about: whose tenant, and when. */
type TenantEventBase = {
  tenantId: string;
  /** Defaults to the database's `now()`; pass it when the action happened earlier than the write. */
  occurredAt?: Date;
};

/**
 * An action on one thread. The tenant-wide configuration acts build on
 * `TenantEventBase` instead — that split is what `buildAuditLogEntry` reads to
 * decide whether an entry has a thread to hang off.
 */
type EventBase = TenantEventBase & {
  /** The thread the action belongs to, on draft actions too, so one query by thread returns the full trail. */
  threadId: string;
};

/**
 * New mail landed in a thread. Persisting is bookkeeping on its own, but it is
 * the first link of the chain the audit trail has to answer for ("why was this
 * mail sent"): without it a classification has no arrival to point back to.
 */
export type MailReceivedEvent = EventBase & {
  action: "mail_received";
  actor: SystemActor;
  /** Provider ids of the messages this poll stored; mail already stored is not repeated. */
  providerMessageIds: string[];
  /** True when the poll created the thread rather than appending to an open one. */
  threadCreated: boolean;
};

export type ThreadClassifiedEvent = EventBase & {
  action: "thread_classified";
  actor: SystemActor;
  /** Null on first triage, set when a thread is re-triaged into another category. */
  previousCategory: TriageCategory | null;
  category: TriageCategory;
  model: string;
};

export type DraftGeneratedEvent = EventBase & {
  action: "draft_generated";
  actor: SystemActor;
  draftId: string;
  model: string;
  /**
   * The language the model detected in the thread and answered in (context.md
   * §6). Null when it did not report one — the draft is still a draft, but "why
   * was this mail written in Spanish" then has no answer here.
   */
  language: string | null;
  /** True when an auto-reply rule asked for this draft rather than the dashboard. */
  autoReply: boolean;
};

export type DraftApprovedEvent = EventBase & {
  action: "draft_approved";
  actor: UserActor;
  draftId: string;
  /** Set only when the user rewrote the model's text before approving (context.md §2). */
  edit?: { from: string; to: string };
};

export type DraftDiscardedEvent = EventBase & {
  action: "draft_discarded";
  actor: UserActor;
  draftId: string;
};

/**
 * Recorded against the *rejected* draft: it is the one whose state changes. The
 * draft that replaces it gets its own `draft_generated` entry, so the two are
 * linked by `replacementDraftId` instead of collapsed into one event.
 */
export type DraftRegeneratedEvent = EventBase & {
  action: "draft_regenerated";
  actor: UserActor;
  draftId: string;
  replacementDraftId: string;
  feedback: string;
};

export type DraftSentEvent = EventBase & {
  action: "draft_sent";
  /** Either: the user who approved it, or the worker job that flushed the send. */
  actor: AuditActor;
  draftId: string;
  sentMessageId: string;
};

/** An auto-reply left the mailbox without anyone approving it — the highest-stakes entry here. */
export type AutoReplySentEvent = EventBase & {
  action: "auto_reply_sent";
  actor: SystemActor;
  draftId: string;
  /** Which category's rule fired, i.e. which switch to look at if this was wrong. */
  category: TriageCategory;
  sentMessageId: string;
};

/**
 * Someone moved a category's auto-reply switch (context.md §2). Not attached to
 * a thread — it is the act that lets *later* mail leave the mailbox with nobody
 * approving it, so without it the trail of an auto-reply stops at "a rule was
 * on" with no record of who turned it on.
 */
export type AutoReplyRuleChangedEvent = TenantEventBase & {
  action: "auto_reply_rule_changed";
  actor: UserActor;
  category: TriageCategory;
  enabled: boolean;
  previousEnabled: boolean;
  /** The guidance the rule now carries; null when the tenant gave none. */
  instructions: string | null;
  /** The guidance it carried before — rewriting it changes what auto-replies say. */
  previousInstructions: string | null;
};

/**
 * An auto-discard rule closed the thread out the moment it was triaged: no
 * draft was ever written, so there is nothing for a reviewer to see (context.md
 * §2, §4). `draftId` points at the empty `discarded` draft written to make the
 * thread read as "Esborrany descartat" on the dashboard.
 */
export type ThreadAutoDiscardedEvent = EventBase & {
  action: "thread_auto_discarded";
  actor: SystemActor;
  draftId: string;
  /** Which category's rule fired, i.e. which switch to look at if this was wrong. */
  category: TriageCategory;
};

/**
 * Someone moved a category's auto-discard switch. Not attached to a thread —
 * it is the act that lets *later* mail be closed out without anyone looking at
 * it, so without it the trail of an auto-discard stops at "a rule was on" with
 * no record of who turned it on.
 */
export type AutoDiscardRuleChangedEvent = TenantEventBase & {
  action: "auto_discard_rule_changed";
  actor: UserActor;
  category: TriageCategory;
  enabled: boolean;
  previousEnabled: boolean;
};

export type AuditEvent =
  | MailReceivedEvent
  | ThreadClassifiedEvent
  | DraftGeneratedEvent
  | DraftApprovedEvent
  | DraftDiscardedEvent
  | DraftRegeneratedEvent
  | DraftSentEvent
  | AutoReplySentEvent
  | AutoReplyRuleChangedEvent
  | ThreadAutoDiscardedEvent
  | AutoDiscardRuleChangedEvent;

/** Derived from the events, so the union above is the single source of truth. */
export type AuditAction = AuditEvent["action"];

/**
 * The same actions as a value, in pipeline order with the configuration act
 * that permits an auto-reply last — for dashboard filters and for iterating
 * them in tests. `satisfies` rejects an action no event declares; a *missing*
 * one is caught by the test that compares this list to the events.
 */
export const AUDIT_ACTIONS = [
  "mail_received",
  "thread_classified",
  "draft_generated",
  "draft_approved",
  "draft_discarded",
  "draft_regenerated",
  "draft_sent",
  "auto_reply_sent",
  "auto_reply_rule_changed",
  "thread_auto_discarded",
  "auto_discard_rule_changed",
] as const satisfies readonly AuditAction[];

type Transition = {
  /** Absent when there is no previous state, e.g. a draft that has just been generated. */
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
  details?: Record<string, unknown>;
};

const draftTransition = (
  before: DraftStatus,
  after: DraftStatus,
  edit?: { from: string; to: string },
): Pick<Transition, "before" | "after"> => ({
  before: { status: before, ...(edit ? { body: edit.from } : {}) },
  after: { status: after, ...(edit ? { body: edit.to } : {}) },
});

const transitionOf = (event: AuditEvent): Transition => {
  switch (event.action) {
    case "mail_received":
      return {
        after: { providerMessageIds: event.providerMessageIds },
        details: { threadCreated: event.threadCreated },
      };
    case "thread_classified":
      return {
        before: { category: event.previousCategory },
        after: { category: event.category },
        details: { model: event.model },
      };
    case "draft_generated":
      return {
        after: { status: "pending" satisfies DraftStatus },
        details: {
          model: event.model,
          language: event.language,
          autoReply: event.autoReply,
        },
      };
    case "draft_approved":
      return draftTransition("pending", "approved", event.edit);
    case "draft_discarded":
      return draftTransition("pending", "discarded");
    case "draft_regenerated":
      return {
        ...draftTransition("pending", "superseded"),
        details: {
          feedback: event.feedback,
          replacementDraftId: event.replacementDraftId,
        },
      };
    case "draft_sent":
      return {
        ...draftTransition("approved", "sent"),
        details: { sentMessageId: event.sentMessageId },
      };
    case "auto_reply_rule_changed":
      return {
        // The guidance rides in the transition rather than in the details: a
        // rewrite with the switch left on is a real change to what goes out
        // unapproved, and a bare `enabled: true -> true` would hide it.
        before: {
          enabled: event.previousEnabled,
          instructions: event.previousInstructions,
        },
        after: { enabled: event.enabled, instructions: event.instructions },
        details: { category: event.category },
      };
    case "auto_reply_sent":
      return {
        // An auto-reply is never approved, so it goes straight from pending to sent.
        ...draftTransition("pending", "sent"),
        details: {
          category: event.category,
          sentMessageId: event.sentMessageId,
        },
      };
    case "thread_auto_discarded":
      return {
        // There is no "before": the draft this entry points at was created
        // discarded, never pending — unlike `draft_discarded`, nobody rejected it.
        after: { status: "discarded" satisfies DraftStatus },
        details: { category: event.category },
      };
    case "auto_discard_rule_changed":
      return {
        before: { enabled: event.previousEnabled },
        after: { enabled: event.enabled },
        details: { category: event.category },
      };
  }
};

/**
 * Turns an event into the row to persist. Public alongside `recordAuditLogEntry`
 * so a caller can fold entries into an insert it is already issuing — several
 * events in one statement, or one `values()` shared with its own writes.
 */
export const buildAuditLogEntry = (event: AuditEvent): NewAuditLogEntry => {
  const { before, after, details } = transitionOf(event);

  return {
    tenantId: event.tenantId,
    actorType: event.actor.type,
    actorUserId: event.actor.type === "user" ? event.actor.userId : null,
    action: event.action,
    threadId: "threadId" in event ? event.threadId : null,
    draftId: "draftId" in event ? event.draftId : null,
    metadata: { ...(before ? { before } : {}), after, ...details },
    ...(event.occurredAt ? { createdAt: event.occurredAt } : {}),
  };
};
