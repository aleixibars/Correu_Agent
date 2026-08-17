// Postgres client for the app (Neon, EU region — context.md §10). Shared with
// the worker only through the Drizzle schema in `shared/`, not through a pool.

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@correu-agent/shared/db/schema";

export type Database = NodePgDatabase<typeof schema>;

// `pg` opens connections lazily, so a missing DATABASE_URL surfaces on the first
// query rather than while Next is collecting route modules at build time.
export const db: Database = drizzle(
  new Pool({ connectionString: process.env.DATABASE_URL }),
  { schema },
);
