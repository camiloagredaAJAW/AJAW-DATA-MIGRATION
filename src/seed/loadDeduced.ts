import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Confidence, DestinationDomain } from "../deduce/deduce.js";
import { upsertFieldMapping } from "../repos/mappingRepo.js";

export interface DeducedSeedRow {
  readonly source_db: string;
  readonly source_table: string;
  readonly source_column: string;
  readonly destination_domain: DestinationDomain;
  readonly destination_field?: string | null;
  readonly additional_info_key?: string | null;
  readonly confidence?: Confidence | "unmapped";
  readonly note?: string;
}

export function parseDeducedSeedRows(json: string): DeducedSeedRow[] {
  return JSON.parse(json) as DeducedSeedRow[];
}

/**
 * The committed dataset uses the sentinel "unmapped" for columns with no
 * destination field. The field_mappings.confidence column's CHECK constraint
 * only allows high/medium/low, so "unmapped" (and an absent confidence) must
 * be normalized to null before insertion.
 */
function normalizeConfidence(confidence: DeducedSeedRow["confidence"]): Confidence | null {
  if (confidence === undefined || confidence === "unmapped") {
    return null;
  }
  return confidence;
}

/**
 * Reads additional_info_key directly from the row's own JSON field. This
 * MUST NOT be recomputed from any static column-name map: the committed
 * dataset is curated per-row (e.g. `matricula` in CO carries
 * `additional_info_key: "sourceRegistrationNumber"`), and a static map can
 * drift out of sync with that curation or simply omit a column. The JSON's
 * own value always wins.
 */
function deriveAdditionalInfoKey(row: DeducedSeedRow): string | null {
  if ((row.destination_field ?? null) !== "additionalInfo") {
    return null;
  }
  return row.additional_info_key ?? null;
}

export interface LoadDeducedSeedResult {
  readonly totalRows: number;
  readonly appliedCount: number;
  readonly skippedAdminCount: number;
}

/**
 * Loads the committed 163-row deduced dataset into field_mappings with
 * origin='seed'. Idempotent: reruns go through the shared mappingRepo, which
 * only ever INSERTs a genuinely new (source_db, source_table, source_column)
 * triple — an existing row for that triple, whatever its origin, is never
 * overwritten. This protects not just admin edits but also curated
 * seed/bootstrap rows that a later reseed's data can't necessarily reproduce,
 * and it means rerunning against an already-seeded database does not
 * duplicate rows.
 */
export function loadDeducedSeed(db: Database.Database, jsonPath: string): LoadDeducedSeedResult {
  const json = readFileSync(jsonPath, "utf-8");
  const rows = parseDeducedSeedRows(json);

  let appliedCount = 0;
  const applyAll = db.transaction((seedRows: DeducedSeedRow[]) => {
    for (const row of seedRows) {
      const destinationField = row.destination_field ?? null;
      const result = upsertFieldMapping(db, {
        sourceDb: row.source_db,
        sourceTable: row.source_table,
        sourceColumn: row.source_column,
        destinationDomain: row.destination_domain,
        destinationField,
        additionalInfoKey: deriveAdditionalInfoKey(row),
        confidence: normalizeConfidence(row.confidence),
        note: row.note ?? null,
        origin: "seed",
      });
      if (result.applied) {
        appliedCount += 1;
      }
    }
  });
  applyAll(rows);

  return {
    totalRows: rows.length,
    appliedCount,
    skippedAdminCount: rows.length - appliedCount,
  };
}
