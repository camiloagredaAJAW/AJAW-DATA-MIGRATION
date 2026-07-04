import type Database from "better-sqlite3";
import type { Confidence, DestinationDomain } from "../deduce/deduce.js";

export type FieldMappingOrigin = "seed" | "bootstrap" | "admin";

export interface UpsertFieldMappingInput {
  readonly sourceDb: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly destinationDomain: DestinationDomain;
  readonly destinationField: string | null;
  readonly additionalInfoKey: string | null;
  readonly confidence: Confidence | null;
  readonly note: string | null;
  readonly origin: FieldMappingOrigin;
}

export interface UpsertFieldMappingResult {
  /**
   * true when the row was newly inserted; false when a row for this
   * (source_db, source_table, source_column) triple already existed and was
   * left untouched, regardless of its origin.
   */
  readonly applied: boolean;
}

const UPSERT_SQL = `
  INSERT INTO field_mappings
    (source_db, source_table, source_column, destination_domain, destination_field,
     additional_info_key, confidence, note, origin, created_at, updated_at)
  VALUES
    (@sourceDb, @sourceTable, @sourceColumn, @destinationDomain, @destinationField,
     @additionalInfoKey, @confidence, @note, @origin, @createdAt, @updatedAt)
  ON CONFLICT(source_db, source_table, source_column) DO NOTHING
`;

/**
 * Inserts a field_mappings row for a brand-new (source_db, source_table,
 * source_column) triple. On conflict — i.e. a row for that triple already
 * exists — the INSERT is a no-op regardless of the existing row's origin.
 *
 * This is intentional, not just an admin-edit guard: seed/bootstrap-origin
 * rows can encode curation that a later, context-free `deduce()` re-run
 * cannot reproduce (e.g. a per-table override the column-name-only
 * heuristic doesn't know about). Re-running the seed loader or the CLI's
 * `sample --refresh` must therefore only ever INSERT genuinely new triples,
 * never UPDATE an existing one — admin, seed, and bootstrap rows are all
 * equally protected once they exist. Intentionally re-deducing an existing
 * row is a separate, explicit operation this function does not perform.
 *
 * This is the single place that protection is enforced; both the seed
 * loader and the live-sampling CLI path go through this function so the
 * rule can never be bypassed by one caller and not the other.
 */
export function upsertFieldMapping(
  db: Database.Database,
  input: UpsertFieldMappingInput,
): UpsertFieldMappingResult {
  const now = new Date().toISOString();
  const statement = db.prepare(UPSERT_SQL);
  const result = statement.run({
    sourceDb: input.sourceDb,
    sourceTable: input.sourceTable,
    sourceColumn: input.sourceColumn,
    destinationDomain: input.destinationDomain,
    destinationField: input.destinationField,
    additionalInfoKey: input.additionalInfoKey,
    confidence: input.confidence,
    note: input.note,
    origin: input.origin,
    createdAt: now,
    updatedAt: now,
  });

  return { applied: result.changes > 0 };
}

export interface FieldMappingRow {
  readonly id: number;
  readonly sourceDb: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly destinationDomain: DestinationDomain;
  readonly destinationField: string | null;
  readonly additionalInfoKey: string | null;
  readonly transform: string | null;
  readonly confidence: Confidence | null;
  readonly note: string | null;
  readonly origin: FieldMappingOrigin;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FieldMappingSqlRow {
  readonly id: number;
  readonly source_db: string;
  readonly source_table: string;
  readonly source_column: string;
  readonly destination_domain: DestinationDomain;
  readonly destination_field: string | null;
  readonly additional_info_key: string | null;
  readonly transform: string | null;
  readonly confidence: Confidence | null;
  readonly note: string | null;
  readonly origin: FieldMappingOrigin;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapSqlRowToFieldMappingRow(row: FieldMappingSqlRow): FieldMappingRow {
  return {
    id: row.id,
    sourceDb: row.source_db,
    sourceTable: row.source_table,
    sourceColumn: row.source_column,
    destinationDomain: row.destination_domain,
    destinationField: row.destination_field,
    additionalInfoKey: row.additional_info_key,
    transform: row.transform,
    confidence: row.confidence,
    note: row.note,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListFieldMappingsFilter {
  readonly sourceDb?: string;
  readonly sourceTable?: string;
}

/**
 * Lists field_mappings rows, optionally filtered by sourceDb and/or
 * sourceTable. Used by the read-only CRUD API's list endpoint.
 */
export function listFieldMappings(
  db: Database.Database,
  filter: ListFieldMappingsFilter = {},
): FieldMappingRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM field_mappings
       WHERE (@sourceDb IS NULL OR source_db = @sourceDb)
         AND (@sourceTable IS NULL OR source_table = @sourceTable)
       ORDER BY source_db, source_table, source_column`,
    )
    .all({
      sourceDb: filter.sourceDb ?? null,
      sourceTable: filter.sourceTable ?? null,
    }) as FieldMappingSqlRow[];

  return rows.map(mapSqlRowToFieldMappingRow);
}

/** Reads a single field_mappings row by id, or null if it does not exist. */
export function getFieldMappingById(db: Database.Database, id: number): FieldMappingRow | null {
  const row = db.prepare(`SELECT * FROM field_mappings WHERE id = ?`).get(id) as
    | FieldMappingSqlRow
    | undefined;

  return row === undefined ? null : mapSqlRowToFieldMappingRow(row);
}

export interface AdminUpdateFieldMappingInput {
  readonly destinationField?: string | null;
  readonly transform?: string | null;
}

/**
 * Applies an admin-initiated edit to an existing field_mappings row via the
 * CRUD API, unconditionally setting origin='admin' — this is what makes
 * `upsertFieldMapping`'s `WHERE origin != 'admin'` guard protect the edit on
 * every later bootstrap/seed rerun. Returns null (no-op) if no row exists for
 * the given id.
 */
export function adminUpdateFieldMapping(
  db: Database.Database,
  id: number,
  input: AdminUpdateFieldMappingInput,
): FieldMappingRow | null {
  const existing = getFieldMappingById(db, id);
  if (existing === null) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE field_mappings
     SET destination_field = @destinationField,
         transform = @transform,
         origin = 'admin',
         updated_at = @updatedAt
     WHERE id = @id`,
  ).run({
    id,
    destinationField:
      input.destinationField !== undefined ? input.destinationField : existing.destinationField,
    transform: input.transform !== undefined ? input.transform : existing.transform,
    updatedAt: now,
  });

  return getFieldMappingById(db, id);
}
