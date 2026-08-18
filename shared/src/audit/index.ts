// Audit trail (context.md §7). Reached as `@correu-agent/shared/audit`, not
// through the root barrel: `record.ts` writes through drizzle, and the barrel is
// imported by browser-bound `app/` code — same constraint as `./db/schema`.

export { AUDIT_ACTIONS, buildAuditLogEntry } from "./events";
export type {
  AuditAction,
  AuditActor,
  AuditEvent,
  AutoReplySentEvent,
  DraftApprovedEvent,
  DraftDiscardedEvent,
  DraftGeneratedEvent,
  DraftRegeneratedEvent,
  DraftSentEvent,
  MailReceivedEvent,
  SystemActor,
  ThreadClassifiedEvent,
  UserActor,
} from "./events";
export { recordAuditLogEntry } from "./record";
