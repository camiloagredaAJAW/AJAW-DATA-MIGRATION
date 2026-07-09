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
  readonly limit?: number;
  readonly offset?: number;
}

interface WhereClause {
  readonly sql: string;
  readonly params: unknown[];
}

function buildWhereClause(filter: Omit<ImportErrorFilter, "limit" | "offset">): WhereClause {
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

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Lists import_errors rows, optionally filtered by run, country, and/or
 * resolved status. An empty filter returns every row. `limit`/`offset`
 * are omitted from the SQL entirely when not provided, preserving the
 * "return everything" behavior existing callers rely on.
 */
export function listImportErrors(
  db: Database.Database,
  filter: ImportErrorFilter,
): ImportErrorRow[] {
  const { sql: whereClause, params } = buildWhereClause(filter);

  // SQLite rejects a bare OFFSET with no LIMIT ("near OFFSET: syntax error"),
  // so an offset-only filter must still emit a LIMIT clause; -1 is SQLite's
  // own convention for "no limit".
  let paginationSql = "";
  if (filter.limit !== undefined || filter.offset !== undefined) {
    paginationSql += " LIMIT ?";
    params.push(filter.limit ?? -1);
    if (filter.offset !== undefined) {
      paginationSql += " OFFSET ?";
      params.push(filter.offset);
    }
  }

  const rows = db
    .prepare(`SELECT * FROM import_errors${whereClause} ORDER BY id${paginationSql}`)
    .all(...params) as Record<string, unknown>[];

  return rows.map(mapSqlRowToImportErrorRow);
}

/**
 * Counts import_errors rows matching the same filter semantics as
 * `listImportErrors`, without fetching full rows — used for pagination
 * metadata and for `MigrationController.status()`'s error tally.
 */
export function countImportErrors(
  db: Database.Database,
  filter: Omit<ImportErrorFilter, "limit" | "offset">,
): number {
  const { sql: whereClause, params } = buildWhereClause(filter);

  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM import_errors${whereClause}`)
    .get(...params) as { count: number };

  return row.count;
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

export interface ErrorAnalyticsBucket {
  readonly day: string;
  readonly hour: string;
  readonly count: number;
  readonly percentage: number;
}

/**
 * Whole-table breakdown of import_errors by UTC day+hour bucket — unlike
 * `listImportErrors`/`countImportErrors`, this ignores runId/countryCode/
 * resolved filters entirely, since it answers "when do errors happen"
 * rather than "how many in the current filtered view". Ordered most-recent
 * bucket first (day DESC, hour DESC). `percentage` is computed in JS (not
 * SQL) to avoid floating-point drift, rounded to 1 decimal place.
 */
export function getErrorAnalytics(db: Database.Database): ErrorAnalyticsBucket[] {
  const rows = db
    .prepare(`
      SELECT
        strftime('%Y-%m-%d', created_at) AS day,
        strftime('%H', created_at) AS hour,
        COUNT(*) AS count
      FROM import_errors
      GROUP BY day, hour
      ORDER BY day DESC, hour DESC
    `)
    .all() as { day: string; hour: string; count: number }[];

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return [];
  }

  return rows.map((row) => ({
    day: row.day,
    hour: row.hour,
    count: row.count,
    percentage: Math.round((row.count / total) * 100 * 10) / 10,
  }));
}
