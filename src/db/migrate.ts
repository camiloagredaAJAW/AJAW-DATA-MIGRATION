import type Database from "better-sqlite3";
import { loadMigrationFiles } from "./migrationLoader.js";

export interface MigrateResult {
  readonly appliedVersions: number[];
}

function schemaMigrationsTableExists(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get();
  return row !== undefined;
}

function getAppliedVersions(db: Database.Database): number[] {
  if (!schemaMigrationsTableExists(db)) {
    return [];
  }
  const rows = db
    .prepare(`SELECT version FROM schema_migrations ORDER BY version ASC`)
    .all() as { version: number }[];
  return rows.map((row) => row.version);
}

/**
 * Applies every ordered `NNN_*.sql` migration file found in `migrationsDir`
 * that has not already been recorded in `schema_migrations`. Each migration
 * runs inside its own transaction, which also records its version, so a
 * failure never leaves a partially-applied migration recorded as applied.
 * Safe to call repeatedly: already-applied versions are skipped.
 */
export function migrate(db: Database.Database, migrationsDir: string): MigrateResult {
  const applied = new Set(getAppliedVersions(db));
  const files = loadMigrationFiles(migrationsDir);
  const pending = files.filter((file) => !applied.has(file.version));

  for (const file of pending) {
    const applyMigration = db.transaction(() => {
      db.exec(file.sql);
      db.prepare(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
      ).run(file.version, new Date().toISOString());
    });
    applyMigration();
  }

  return { appliedVersions: pending.map((file) => file.version) };
}
