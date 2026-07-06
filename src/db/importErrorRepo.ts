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
