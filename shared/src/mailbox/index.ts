// Server- and worker-only entry point (`@correu-agent/shared/mailbox`): it
// reaches drizzle and `node:crypto`, so it stays out of the root barrel that
// browser-bound code imports.

export * from "./connect";
export * from "./persist";
export * from "./microsoft-mail";
export * from "./microsoft";
