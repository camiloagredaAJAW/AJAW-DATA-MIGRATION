import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migrate", () => {
  it("creates schema_migrations and applies every ordered migration file on a fresh database", () => {
    const db = new Database(":memory:");

    const result = migrate(db, migrationsDir);

    expect(result.appliedVersions).toEqual([1, 2, 3, 4]);
    expect(tableNames(db)).toEqual([
      "field_mappings",
      "sanitization_rules",
      "schema_migrations",
      "source_catalog",
    ]);

    const appliedRows = db
      .prepare(`SELECT version FROM schema_migrations ORDER BY version ASC`)
      .all() as { version: number }[];
    expect(appliedRows.map((row) => row.version)).toEqual([1, 2, 3, 4]);
  });

  it("is idempotent: rerunning migrate on an already-migrated database applies nothing new", () => {
    const db = new Database(":memory:");

    migrate(db, migrationsDir);
    const second = migrate(db, migrationsDir);

    expect(second.appliedVersions).toEqual([]);

    const countRow = db
      .prepare(`SELECT COUNT(*) as count FROM schema_migrations`)
      .get() as { count: number };
    expect(countRow.count).toBe(4);
  });

  it("enforces the unique (source_db, source_table, source_column) constraint on field_mappings", () => {
    const db = new Database(":memory:");
    migrate(db, migrationsDir);

    const insert = db.prepare(`
      INSERT INTO field_mappings
        (source_db, source_table, source_column, destination_domain, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    insert.run("ar", "companies", "cuit", "AiSearchResults", "seed", now, now);

    expect(() =>
      insert.run("ar", "companies", "cuit", "AiSearchResults", "seed", now, now),
    ).toThrowError(/UNIQUE constraint failed/);
  });

  it("rejects an invalid destination_domain via the CHECK constraint", () => {
    const db = new Database(":memory:");
    migrate(db, migrationsDir);

    const insert = db.prepare(`
      INSERT INTO field_mappings
        (source_db, source_table, source_column, destination_domain, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();

    expect(() =>
      insert.run("ar", "companies", "cuit", "NotARealDomain", "seed", now, now),
    ).toThrowError(/CHECK constraint failed/);
  });
});
