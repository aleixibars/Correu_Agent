// Shared types and constants used by both `app/` and `worker/`.

// Token encryption is deliberately NOT re-exported here: it imports
// `node:crypto`, and this barrel is imported by browser-bound `app/` code.
// Server/worker code imports it from `@correu-agent/shared/token-encryption`.

export const APP_NAME = "Correu Agent";

export * from "./triage";
export * from "./db/schema";
