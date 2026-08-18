import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { auditLogEntries } from "../db/schema";
import { buildAuditLogEntry, type AuditEvent } from "./events";

/**
 * Writes one audit entry. Generic over the query-result type so it accepts any
 * Drizzle Postgres database — the app's connection, the worker's, or a
 * transaction handle passed in from an enclosing write.
 */
export const recordAuditLogEntry = async <
  T extends PgQueryResultHKT,
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  db: PgDatabase<T, TSchema>,
  event: AuditEvent,
): Promise<void> => {
  await db.insert(auditLogEntries).values(buildAuditLogEntry(event));
};
