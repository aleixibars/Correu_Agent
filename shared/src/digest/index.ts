// Daily digest (context.md §2, §5): the day's grouped threads, the Sonnet call
// that writes them up, and the write that stores it for the dashboard.
// Server- and worker-only entry point (`@correu-agent/shared/digest`) because it
// reaches drizzle and the Anthropic SDK.

export * from "./collect";
export * from "./summarise";
export * from "./generate";
