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
 * Reads the most recently updated checkpoint for a country across ANY run,
 * or null if that country has never been checkpointed at all. Used to carry
 * forward a prior run's progress (offset + AiSearch parent id) into a
 * brand-new run for the same country, instead of silently restarting it
 * from 0 (e.g. a `/stop` followed by a fresh `/start`).
 */
export function getMostRecentCheckpointForCountry(
  db: Database.Database,
  countryCode: string,
): MigrationCheckpointRow | null {
  const row = db
    .prepare(`
      SELECT * FROM migration_checkpoints
      WHERE country_code = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `)
    .get(countryCode) as Record<string, unknown> | undefined;

  return row === undefined ? null : mapSqlRowToCheckpointRow(row);
}

/**
 * Ensures a checkpoint row exists for (run_id, country_code). Idempotent: a
 * second call for the same pair returns the existing row untouched (never
 * resets progress already made for that country in this run).
 *
 * On first creation for a given run, this does NOT blindly default to
 * last_offset=0/ai_search_id=null. It first looks up the most recent
 * checkpoint for that country across ANY prior run and seeds the new row
 * from it (carrying forward offset + AiSearch parent id). This is what
 * makes a brand-new run started after a `/stop` resume that country from
 * its last persisted offset instead of restarting it from scratch. Only
 * when the country has never been checkpointed by any run does it fall
 * back to the original 0/null defaults.
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

  const priorCheckpoint = getMostRecentCheckpointForCountry(db, countryCode);
  const seedOffset = priorCheckpoint?.lastOffset ?? 0;
  const seedAiSearchId = priorCheckpoint?.aiSearchId ?? null;

  const now = new Date().toISOString();
  const result = db
    .prepare(`
      INSERT INTO migration_checkpoints
        (run_id, country_code, ai_search_id, last_offset, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `)
    .run(runId, countryCode, seedAiSearchId, seedOffset, now, now);

  const checkpoint = getCheckpointById(db, Number(result.lastInsertRowid));
  if (checkpoint === null) {
    throw new Error("Failed to read back newly created migration_checkpoints row");
  }
  return checkpoint;
}

/**
 * Lists every checkpoint for a run, ordered by country_code, so a status
 * endpoint can report per-country progress. Returns an empty array when the
 * run has no checkpoints yet.
 */
export function listByRun(db: Database.Database, runId: number): MigrationCheckpointRow[] {
  const rows = db
    .prepare(`SELECT * FROM migration_checkpoints WHERE run_id = ? ORDER BY country_code`)
    .all(runId) as Record<string, unknown>[];

  return rows.map(mapSqlRowToCheckpointRow);
}

/**
 * Lists the single most recent checkpoint for EVERY country that has ever
 * been checkpointed, across ALL runs — not just one run's worth. Ordered by
 * country_code, matching `listByRun`'s display order.
 *
 * Unlike `listByRun`, this is what a dashboard's "Per-Country Progress"
 * table needs once a single-country retry can spin up its own
 * `migration_runs` row: sourcing checkpoints from only "the most recent
 * run" would make every OTHER country's progress disappear, even though
 * their checkpoint rows still exist safely under an older run_id.
 *
 * The correlated subquery orders by `updated_at DESC, id DESC` — the exact
 * same tie-break as `getMostRecentCheckpointForCountry` above — so the two
 * functions can never disagree about which row is "latest" for a given
 * country. `id DESC` alone would pick the row created last, which is not
 * necessarily the row touched last (e.g. `advanceOffset`/`setStatus` update
 * `updated_at` on an existing row without changing its id).
 */
export function listLatestCheckpointsPerCountry(db: Database.Database): MigrationCheckpointRow[] {
  const rows = db
    .prepare(`
      SELECT * FROM migration_checkpoints mc
      WHERE mc.id = (
        SELECT id FROM migration_checkpoints mc2
        WHERE mc2.country_code = mc.country_code
        ORDER BY mc2.updated_at DESC, mc2.id DESC LIMIT 1
      )
      ORDER BY mc.country_code ASC
    `)
    .all() as Record<string, unknown>[];

  return rows.map(mapSqlRowToCheckpointRow);
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
