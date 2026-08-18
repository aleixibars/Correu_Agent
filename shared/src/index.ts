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
//   - `./digest` reaches drizzle and the Anthropic SDK.
//   - `./triage` reaches drizzle and the Anthropic SDK; the taxonomy alone
//     (`./triage/taxonomy`) is browser-safe and is re-exported below.
//   - `./drafts` reaches drizzle and the Anthropic SDK too.
//   - `./auto-reply` writes the per-category rules through drizzle.
// Server and worker code imports them from `@correu-agent/shared/token-encryption`,
// `@correu-agent/shared/web-push`, `@correu-agent/shared/db/schema`,
// `@correu-agent/shared/audit`, `@correu-agent/shared/mailbox`,
// `@correu-agent/shared/mail`, `@correu-agent/shared/retention`,
// `@correu-agent/shared/digest`, `@correu-agent/shared/triage`,
// `@correu-agent/shared/drafts` and `@correu-agent/shared/auto-reply`.

export const APP_NAME = "Correu Agent";
export const APP_DESCRIPTION = "Automatització de correu per a empreses.";

export * from "./triage/taxonomy";
