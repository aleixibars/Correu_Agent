// Triage (context.md §4): the taxonomy, the Haiku classifier and the write that
// stores a thread's category. Server- and worker-only entry point
// (`@correu-agent/shared/triage`) because it reaches drizzle and the Anthropic
// SDK; browser-bound code gets the taxonomy alone from the root barrel.

export * from "./taxonomy";
export * from "./classify";
export * from "./client";
export * from "./triage-thread";
