// Postgres client for the worker (Neon, EU region — context.md §10). Separate
// pool from the app's: the two services share the Drizzle schema in `shared/`,
// never a connection.

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@correu-agent/shared/db/schema";

export type Database = NodePgDatabase<typeof schema>;

export const createDatabase = (connectionString: string): Database =>
  drizzle(new Pool({ connectionString }), { schema });
