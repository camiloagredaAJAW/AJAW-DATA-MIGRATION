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
   * true when the row was inserted or updated; false when an existing row
   * was skipped because it is owned by an admin edit (origin = 'admin').
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
  ON CONFLICT(source_db, source_table, source_column) DO UPDATE SET
    destination_domain = excluded.destination_domain,
    destination_field = excluded.destination_field,
    additional_info_key = excluded.additional_info_key,
    confidence = excluded.confidence,
    note = excluded.note,
    updated_at = excluded.updated_at
  WHERE field_mappings.origin != 'admin'
`;

/**
 * Inserts a field_mappings row, or updates it in place on a
 * (source_db, source_table, source_column) conflict — UNLESS the existing
 * row's origin is 'admin', in which case the UPDATE clause's WHERE guard
 * prevents any change and no row is inserted (it already exists). This is
 * the single place admin-edit protection is enforced; both the seed loader
 * and the live-sampling CLI path go through this function so the rule can
 * never be bypassed by one caller and not the other.
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
