import type Database from "better-sqlite3";
import { mapRowKeysToCamelCase } from "./sqlRowMapping.js";

export type MigrationRunStatus = "running" | "paused" | "stopped" | "completed" | "failed";

export interface MigrationRunRow {
  readonly id: number;
  readonly status: MigrationRunStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
}

function mapSqlRowToMigrationRunRow(row: Record<string, unknown>): MigrationRunRow {
  return mapRowKeysToCamelCase<MigrationRunRow>(row);
}

/** Reads a single migration_runs row by id, or null if it does not exist. */
export function getRunById(db: Database.Database, id: number): MigrationRunRow | null {
  const row = db.prepare(`SELECT * FROM migration_runs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;

  return row === undefined ? null : mapSqlRowToMigrationRunRow(row);
}

/**
 * Reads the most recent migration_runs row whose status is 'running' or
 * 'paused' (both count as "active" for concurrency purposes — see the
 * migration-controls spec), or null if none exists.
 */
export function getActiveRun(db: Database.Database): MigrationRunRow | null {
  const row = db
    .prepare(
      `SELECT * FROM migration_runs WHERE status IN ('running', 'paused') ORDER BY id DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;

  return row === undefined ? null : mapSqlRowToMigrationRunRow(row);
}

/**
 * Creates a new migration_runs row with status='running' and returns it.
 * Each CLI invocation of the engine starts exactly one run.
 */
export function createRun(db: Database.Database): MigrationRunRow {
  const now = new Date().toISOString();
  const result = db
    .prepare(`INSERT INTO migration_runs (status, started_at, updated_at) VALUES (?, ?, ?)`)
    .run("running", now, now);

  const run = getRunById(db, Number(result.lastInsertRowid));
  if (run === null) {
    throw new Error("Failed to read back newly created migration_runs row");
  }
  return run;
}

/**
 * Updates the status (and updated_at) of an existing migration_runs row.
 * Returns null (no-op) if no row exists for the given id.
 */
export function updateRunStatus(
  db: Database.Database,
  id: number,
  status: MigrationRunStatus,
): MigrationRunRow | null {
  const existing = getRunById(db, id);
  if (existing === null) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE migration_runs SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    now,
    id,
  );

  return getRunById(db, id);
}
