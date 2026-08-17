// Shared types and constants used by both `app/` and `worker/`.

// Two modules are deliberately NOT re-exported here, because this barrel is
// imported by browser-bound `app/` code:
//   - `./token-encryption` imports `node:crypto`.
//   - `./db/schema` pulls in drizzle-orm and is server/worker-only.
// Server and worker code imports them from `@correu-agent/shared/token-encryption`
// and `@correu-agent/shared/db/schema`.

export const APP_NAME = "Correu Agent";

export * from "./triage";
