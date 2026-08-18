// Retention job entry point (`@correu-agent/shared/retention`): it writes
// through drizzle, so it stays out of the root barrel that browser-bound `app/`
// code imports — same constraint as `./db/schema`.

export {
  PURGED_SUMMARY_LENGTH,
  RETENTION_DAYS,
  purgeExpiredMessageBodies,
  retentionCutoff,
} from "./purge";
export type {
  PurgeExpiredMessageBodiesOptions,
  PurgedMessageBody,
} from "./purge";
