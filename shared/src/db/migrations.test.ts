import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import {
  PgDialect,
  PgTable,
  getTableConfig,
  isPgEnum,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";

// The migrations committed under `shared/drizzle/` are what actually reaches
// Neon; `schema.ts` is only the source they were generated from. Nothing else
// in CI runs `drizzle-kit`, so without this an edit to `schema.ts` that nobody
// regenerated stays green here and silently never reaches the database.

interface SnapshotColumn {
  name: string;
  type: string;
  notNull: boolean;
}

interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  uniqueConstraints: Record<string, { name: string; columns: string[] }>;
  checkConstraints: Record<string, { name: string; value: string }>;
  indexes: Record<string, { name: string }>;
}

interface Snapshot {
  tables: Record<string, SnapshotTable>;
  enums: Record<string, { name: string; values: string[] }>;
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(join(migrationsDir, path), "utf8")) as T;

/** Drizzle snapshots are cumulative, so the newest one is the whole expected database. */
const latestSnapshot = (): Snapshot => {
  const { entries } = readJson<{ entries: { idx: number }[] }>(
    "meta/_journal.json",
  );
  const newest = entries.reduce((latest, entry) =>
    entry.idx > latest.idx ? entry : latest,
  );
  return readJson<Snapshot>(
    `meta/${String(newest.idx).padStart(4, "0")}_snapshot.json`,
  );
};

const snapshot = latestSnapshot();

const dialect = new PgDialect();

// Widened to `unknown` so the two type guards below accept them: the module's
// own value union is a list of specific table and enum types, not their bases.
const exported: unknown[] = Object.values(schema);

const schemaTables = exported.filter((value): value is PgTable =>
  is(value, PgTable),
);

describe("committed migrations", () => {
  it("covers every table in the schema, and no extra ones", () => {
    expect(
      schemaTables.map((table) => getTableConfig(table).name).sort(),
    ).toEqual(Object.values(snapshot.tables).map((table) => table.name).sort());
  });

  it.each(
    schemaTables.map((table) => [getTableConfig(table).name, table] as const),
  )("matches %s column for column", (name, table) => {
    const expected = Object.fromEntries(
      getTableConfig(table).columns.map((column) => [
        column.name,
        { type: column.getSQLType(), notNull: column.notNull },
      ]),
    );
    const migrated = Object.fromEntries(
      Object.values(snapshot.tables[`public.${name}`]?.columns ?? {}).map(
        (column) => [column.name, { type: column.type, notNull: column.notNull }],
      ),
    );
    expect(migrated).toEqual(expected);
  });

  it.each(
    schemaTables.map((table) => [getTableConfig(table).name, table] as const),
  )("matches the constraints and indexes on %s", (name, table) => {
    const config = getTableConfig(table);
    const migrated = snapshot.tables[`public.${name}`];

    expect(
      Object.values(migrated?.uniqueConstraints ?? {}).map((constraint) => [
        constraint.name,
        constraint.columns,
      ]),
    ).toEqual(
      config.uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map((column) => column.name),
      ]),
    );
    // Compared by rendered SQL, not just by name: the auto-reply eligibility
    // check is derived from `AUTO_REPLY_ELIGIBLE_CATEGORIES`, so editing that
    // list changes the constraint while leaving its name untouched.
    expect(
      Object.values(migrated?.checkConstraints ?? {}).map((constraint) => [
        constraint.name,
        constraint.value,
      ]),
    ).toEqual(
      config.checks.map((constraint) => [
        constraint.name,
        dialect.sqlToQuery(constraint.value).sql,
      ]),
    );
    expect(Object.keys(migrated?.indexes ?? {})).toEqual(
      config.indexes.map((index) => index.config.name),
    );
  });

  it("matches the enum values the schema declares", () => {
    const expected = Object.fromEntries(
      exported
        .filter(isPgEnum)
        .map((enumeration) => [
          enumeration.enumName,
          [...enumeration.enumValues],
        ]),
    );
    const migrated = Object.fromEntries(
      Object.values(snapshot.enums).map((enumeration) => [
        enumeration.name,
        enumeration.values,
      ]),
    );
    expect(migrated).toEqual(expected);
  });
});
