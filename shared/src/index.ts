// Shared types and constants used by both `app/` and `worker/`.

// Three modules are deliberately NOT re-exported here, because this barrel is
// imported by browser-bound `app/` code:
//   - `./token-encryption` imports `node:crypto`.
//   - `./web-push` imports the Node-only `web-push` package.
//   - `./db/schema` pulls in drizzle-orm and is server/worker-only.
//   - `./audit` writes through drizzle, so it is server/worker-only too.
// Server and worker code imports them from `@correu-agent/shared/token-encryption`,
// `@correu-agent/shared/web-push`, `@correu-agent/shared/db/schema` and
// `@correu-agent/shared/audit`.

export const APP_NAME = "Correu Agent";

export * from "./triage";
