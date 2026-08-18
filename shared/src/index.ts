// Shared types and constants used by both `app/` and `worker/`.

// These modules are deliberately NOT re-exported here, because this barrel is
// imported by browser-bound `app/` code:
//   - `./token-encryption` imports `node:crypto`.
//   - `./web-push` imports the Node-only `web-push` package.
//   - `./db/schema` pulls in drizzle-orm and is server/worker-only.
//   - `./audit` writes through drizzle, so it is server/worker-only too.
//   - `./mailbox` reaches both drizzle and `node:crypto`.
//   - `./mail` calls the provider APIs directly and decodes with `node:buffer`.
//   - `./retention` writes through drizzle as well.
// Server and worker code imports them from `@correu-agent/shared/token-encryption`,
// `@correu-agent/shared/web-push`, `@correu-agent/shared/db/schema`,
// `@correu-agent/shared/audit`, `@correu-agent/shared/mailbox`,
// `@correu-agent/shared/mail` and `@correu-agent/shared/retention`.

export const APP_NAME = "Correu Agent";

export * from "./triage";
