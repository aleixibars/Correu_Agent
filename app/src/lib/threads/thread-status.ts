import type { DraftStatus } from "@correu-agent/shared/db/schema";

// Estat d'un fil al tauler: no és una columna de la base de dades, sinó el que
// el revisor n'ha de fer ara mateix — derivat del triatge del fil (context.md
// §4) i de l'esborrany viu que hi pengi (context.md §2).
export const THREAD_STATUSES = [
  "awaiting-triage",
  "triaged",
  "draft-pending",
  "draft-approved",
  "replied",
  "draft-discarded",
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export interface ThreadStatusInput {
  triagedAt: Date | null;
  /** The live draft of the thread, or null while it has none. */
  draftStatus: DraftStatus | null;
}

const DRAFT_STATUSES: Partial<Record<DraftStatus, ThreadStatus>> = {
  pending: "draft-pending",
  approved: "draft-approved",
  sent: "replied",
  discarded: "draft-discarded",
  // `superseded` is deliberately absent: a regeneration replaced that draft
  // (context.md §2), so it says nothing about what the thread is waiting for.
};

export const threadStatus = ({
  triagedAt,
  draftStatus,
}: ThreadStatusInput): ThreadStatus => {
  if (triagedAt === null) return "awaiting-triage";
  return (draftStatus && DRAFT_STATUSES[draftStatus]) ?? "triaged";
};

const STATUS_LABELS: Record<ThreadStatus, string> = {
  "awaiting-triage": "Pendent de triatge",
  triaged: "Triat",
  "draft-pending": "Esborrany pendent de revisió",
  "draft-approved": "Esborrany aprovat",
  replied: "Resposta enviada",
  "draft-discarded": "Esborrany descartat",
};

export const threadStatusLabel = (status: ThreadStatus): string =>
  STATUS_LABELS[status];
