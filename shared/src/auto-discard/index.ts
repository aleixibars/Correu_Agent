// Granular auto-discard rules (context.md §2, §4). Server- and worker-only
// entry point (`@correu-agent/shared/auto-discard`) because it reaches
// drizzle; the taxonomy that says which categories are eligible is
// browser-safe and lives in the root barrel instead.

export * from "./apply";
export * from "./match";
export * from "./patterns";
export * from "./rules";
