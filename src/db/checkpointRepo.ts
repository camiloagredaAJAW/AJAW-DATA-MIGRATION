import type Database from "better-sqlite3";
import { mapRowKeysToCamelCase } from "./sqlRowMapping.js";

export type MigrationCheckpointStatus = "pending" | "in_progress" | "completed" | "failed";

export interface MigrationCheckpointRow {
  readonly id: number;
  readonly runId: number;
  readonly countryCode: string;
  readonly aiSearchId: number | null;
  readonly lastOffset: number;
  readonly status: MigrationCheckpointStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function mapSqlRowToCheckpointRow(row: Record<string, unknown>): MigrationCheckpointRow {
  return mapRowKeysToCamelCase<MigrationCheckpointRow>(row);
}

/** Reads a single migration_checkpoints row by id, or null if it does not exist. */
export function getCheckpointById(
  db: Database.Database,
  id: number,
): MigrationCheckpointRow | null {
  const row = db.prepare(`SELECT * FROM migration_checkpoints WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;

  return row === undefined ? null : mapSqlRowToCheckpointRow(row);
}

/**
 * Reads the checkpoint for a (run_id, country_code) pair, or null if none
 * has been created yet.
 */
export function getByRunCountry(
  db: Database.Database,
  runId: number,
  countryCode: string,
): MigrationCheckpointRow | null {
  const row = db
    .prepare(`SELECT * FROM migration_checkpoints WHERE run_id = ? AND country_code = ?`)
    .get(runId, countryCode) as Record<string, unknown> | undefined;

  return row === undefined ? null : mapSqlRowToCheckpointRow(row);
}

/**
 * Ensures a checkpoint row exists for (run_id, country_code), creating it
 * with status='pending' and last_offset=0 on first call. Idempotent: a
 * second call for the same pair returns the existing row untouched (never
 * resets progress already made for that country in this run).
 */
export function upsertCheckpoint(
  db: Database.Database,
  runId: number,
  countryCode: string,
): MigrationCheckpointRow {
  const existing = getByRunCountry(db, runId, countryCode);
  if (existing !== null) {
    return existing;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(`
      INSERT INTO migration_checkpoints
        (run_id, country_code, last_offset, status, created_at, updated_at)
      VALUES (?, ?, 0, 'pending', ?, ?)
    `)
    .run(runId, countryCode, now, now);

  const checkpoint = getCheckpointById(db, Number(result.lastInsertRowid));
  if (checkpoint === null) {
    throw new Error("Failed to read back newly created migration_checkpoints row");
  }
  return checkpoint;
}

/** Sets last_offset on an existing checkpoint. Returns null if it does not exist. */
export function advanceOffset(
  db: Database.Database,
  id: number,
  newOffset: number,
): MigrationCheckpointRow | null {
  const existing = getCheckpointById(db, id);
  if (existing === null) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE migration_checkpoints SET last_offset = ?, updated_at = ? WHERE id = ?`).run(
    newOffset,
    now,
    id,
  );

  return getCheckpointById(db, id);
}

/**
 * Persists the AiSearch parent id for this checkpoint's country. Returns
 * null if the checkpoint does not exist.
 */
export function setAiSearchId(
  db: Database.Database,
  id: number,
  aiSearchId: number,
): MigrationCheckpointRow | null {
  const existing = getCheckpointById(db, id);
  if (existing === null) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE migration_checkpoints SET ai_search_id = ?, updated_at = ? WHERE id = ?`).run(
    aiSearchId,
    now,
    id,
  );

  return getCheckpointById(db, id);
}

/** Updates the checkpoint status. Returns null if it does not exist. */
export function setStatus(
  db: Database.Database,
  id: number,
  status: MigrationCheckpointStatus,
): MigrationCheckpointRow | null {
  const existing = getCheckpointById(db, id);
  if (existing === null) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE migration_checkpoints SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    now,
    id,
  );

  return getCheckpointById(db, id);
}
