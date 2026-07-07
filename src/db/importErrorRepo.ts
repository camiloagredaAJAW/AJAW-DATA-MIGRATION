import type Database from "better-sqlite3";
import { mapRowKeysToCamelCase } from "./sqlRowMapping.js";

export interface ImportErrorRow {
  readonly id: number;
  readonly runId: number;
  readonly countryCode: string;
  readonly recordOffset: number | null;
  readonly recordIdentifier: string | null;
  readonly errorReason: string;
  readonly resolved: boolean;
  readonly createdAt: string;
}

/**
 * `resolved` is stored as SQLite's 0/1 integer; every other field maps
 * 1:1 via the shared snake_case->camelCase helper, so only that field needs
 * post-mapping coercion.
 */
interface ImportErrorRowWithRawResolved extends Omit<ImportErrorRow, "resolved"> {
  readonly resolved: 0 | 1;
}

function mapSqlRowToImportErrorRow(row: Record<string, unknown>): ImportErrorRow {
  const mapped = mapRowKeysToCamelCase<ImportErrorRowWithRawResolved>(row);
  return { ...mapped, resolved: mapped.resolved === 1 };
}

export interface RecordErrorInput {
  readonly runId: number;
  readonly countryCode: string;
  readonly recordOffset: number | null;
  readonly recordIdentifier: string | null;
  readonly errorReason: string;
}

/**
 * Inserts an import_errors row capturing only operational failure metadata
 * (reason, country, offset/identifier, timestamp) — never the raw record
 * payload, per the migration-persistence spec.
 */
export function recordError(db: Database.Database, input: RecordErrorInput): ImportErrorRow {
  const now = new Date().toISOString();
  const result = db
    .prepare(`
      INSERT INTO import_errors
        (run_id, country_code, record_offset, record_identifier, error_reason, resolved, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `)
    .run(
      input.runId,
      input.countryCode,
      input.recordOffset,
      input.recordIdentifier,
      input.errorReason,
      now,
    );

  const row = db
    .prepare(`SELECT * FROM import_errors WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error("Failed to read back newly created import_errors row");
  }
  return mapSqlRowToImportErrorRow(row);
}

/** Reads a single import_errors row by id, or null if it does not exist. */
export function getImportErrorById(db: Database.Database, id: number): ImportErrorRow | null {
  const row = db.prepare(`SELECT * FROM import_errors WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;

  return row === undefined ? null : mapSqlRowToImportErrorRow(row);
}

export interface ImportErrorFilter {
  readonly runId?: number;
  readonly countryCode?: string;
  readonly resolved?: boolean;
}

/**
 * Lists import_errors rows, optionally filtered by run, country, and/or
 * resolved status. An empty filter returns every row.
 */
export function listImportErrors(
  db: Database.Database,
  filter: ImportErrorFilter,
): ImportErrorRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.runId !== undefined) {
    clauses.push("run_id = ?");
    params.push(filter.runId);
  }
  if (filter.countryCode !== undefined) {
    clauses.push("country_code = ?");
    params.push(filter.countryCode);
  }
  if (filter.resolved !== undefined) {
    clauses.push("resolved = ?");
    params.push(filter.resolved ? 1 : 0);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM import_errors${whereClause} ORDER BY id`)
    .all(...params) as Record<string, unknown>[];

  return rows.map(mapSqlRowToImportErrorRow);
}

/**
 * Marks an import_errors row as resolved (e.g. after a successful retry).
 * Returns null if the row does not exist.
 */
export function markResolved(db: Database.Database, id: number): ImportErrorRow | null {
  const existing = getImportErrorById(db, id);
  if (existing === null) {
    return null;
  }

  db.prepare(`UPDATE import_errors SET resolved = 1 WHERE id = ?`).run(id);

  return getImportErrorById(db, id);
}

/**
 * Overwrites the error_reason on an existing import_errors row (e.g. after a
 * failed retry attempt records why it failed again). Leaves `resolved`
 * unchanged. Returns null if the row does not exist.
 */
export function updateErrorReason(
  db: Database.Database,
  id: number,
  reason: string,
): ImportErrorRow | null {
  const existing = getImportErrorById(db, id);
  if (existing === null) {
    return null;
  }

  db.prepare(`UPDATE import_errors SET error_reason = ? WHERE id = ?`).run(reason, id);

  return getImportErrorById(db, id);
}
