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

    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tableNames(db)).toEqual([
      "field_mappings",
      "import_errors",
      "migration_checkpoints",
      "migration_runs",
      "sanitization_rules",
      "schema_migrations",
      "source_catalog",
    ]);

    const appliedRows = db
      .prepare(`SELECT version FROM schema_migrations ORDER BY version ASC`)
      .all() as { version: number }[];
    expect(appliedRows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("is idempotent: rerunning migrate on an already-migrated database applies nothing new", () => {
    const db = new Database(":memory:");

    migrate(db, migrationsDir);
    const second = migrate(db, migrationsDir);

    expect(second.appliedVersions).toEqual([]);

    const countRow = db
      .prepare(`SELECT COUNT(*) as count FROM schema_migrations`)
      .get() as { count: number };
    expect(countRow.count).toBe(8);
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

  it("creates indexes on migration_checkpoints.country_code and import_errors.resolved — both queried on every 10-second dashboard poll", () => {
    const db = new Database(":memory:");
    migrate(db, migrationsDir);

    const checkpointIndexes = db.prepare(`PRAGMA index_list(migration_checkpoints)`).all() as {
      name: string;
    }[];
    const importErrorIndexes = db.prepare(`PRAGMA index_list(import_errors)`).all() as {
      name: string;
    }[];

    expect(checkpointIndexes.map((index) => index.name)).toContain(
      "idx_migration_checkpoints_country_code",
    );
    expect(importErrorIndexes.map((index) => index.name)).toContain("idx_import_errors_resolved");

    const checkpointIndexInfo = db
      .prepare(`PRAGMA index_info(idx_migration_checkpoints_country_code)`)
      .all() as { name: string }[];
    expect(checkpointIndexInfo.map((column) => column.name)).toEqual(["country_code"]);

    const importErrorIndexInfo = db
      .prepare(`PRAGMA index_info(idx_import_errors_resolved)`)
      .all() as { name: string }[];
    expect(importErrorIndexInfo.map((column) => column.name)).toEqual(["resolved"]);
  });
});

describe("migration_runs / migration_checkpoints / import_errors DDL", () => {
  function freshDb(): Database.Database {
    const db = new Database(":memory:");
    migrate(db, migrationsDir);
    return db;
  }

  function insertRun(db: Database.Database, status = "running"): number {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO migration_runs (status, started_at, updated_at) VALUES (?, ?, ?)`,
      )
      .run(status, now, now);
    return Number(result.lastInsertRowid);
  }

  it("rejects an invalid migration_runs.status via the CHECK constraint", () => {
    const db = freshDb();
    const now = new Date().toISOString();

    expect(() =>
      db
        .prepare(`INSERT INTO migration_runs (status, started_at, updated_at) VALUES (?, ?, ?)`)
        .run("bogus", now, now),
    ).toThrowError(/CHECK constraint failed/);
  });

  it("enforces the UNIQUE(run_id, country_code) constraint on migration_checkpoints", () => {
    const db = freshDb();
    const runId = insertRun(db);
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO migration_checkpoints
        (run_id, country_code, last_offset, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(runId, "ar", 0, "pending", now, now);

    expect(() => insert.run(runId, "ar", 0, "pending", now, now)).toThrowError(
      /UNIQUE constraint failed/,
    );
  });

  it("rejects an invalid migration_checkpoints.status via the CHECK constraint", () => {
    const db = freshDb();
    const runId = insertRun(db);
    const now = new Date().toISOString();

    expect(() =>
      db
        .prepare(`
          INSERT INTO migration_checkpoints
            (run_id, country_code, last_offset, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(runId, "ar", 0, "bogus", now, now),
    ).toThrowError(/CHECK constraint failed/);
  });

  it("enforces the migration_checkpoints.run_id foreign key", () => {
    const db = freshDb();
    const now = new Date().toISOString();

    expect(() =>
      db
        .prepare(`
          INSERT INTO migration_checkpoints
            (run_id, country_code, last_offset, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(999999, "ar", 0, "pending", now, now),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it("rejects an invalid import_errors.resolved value via the CHECK constraint", () => {
    const db = freshDb();
    const runId = insertRun(db);
    const now = new Date().toISOString();

    expect(() =>
      db
        .prepare(`
          INSERT INTO import_errors
            (run_id, country_code, error_reason, resolved, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(runId, "ar", "boom", 2, now),
    ).toThrowError(/CHECK constraint failed/);
  });

  it("enforces the import_errors.run_id foreign key", () => {
    const db = freshDb();
    const now = new Date().toISOString();

    expect(() =>
      db
        .prepare(`
          INSERT INTO import_errors
            (run_id, country_code, error_reason, resolved, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(999999, "ar", "boom", 0, now),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });
});
