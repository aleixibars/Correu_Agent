import { defineConfig } from "drizzle-kit";

// Migrations run against Neon (EU region, context.md §10) via DATABASE_URL.
// `drizzle-kit generate` only needs the schema; `migrate`/`push` need the URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
