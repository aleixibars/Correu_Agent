// Draft generation (context.md §2): the Sonnet drafter, the RFC 5322 headers
// that keep a reply inside its thread and the write that stores one. Server- and
// worker-only entry point (`@correu-agent/shared/drafts`) because it reaches
// drizzle and the Anthropic SDK.

export * from "./generate";
export * from "./generate-draft";
export * from "./reply-headers";
export * from "./send";
