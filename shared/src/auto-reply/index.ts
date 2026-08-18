// Granular auto-reply rules (context.md §2). Server- and worker-only entry point
// (`@correu-agent/shared/auto-reply`) because it reaches drizzle; the taxonomy
// that says which categories are eligible is browser-safe and lives in the root
// barrel instead.

export * from "./rules";
