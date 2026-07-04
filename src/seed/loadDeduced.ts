import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Confidence, DestinationDomain } from "../deduce/deduce.js";
import { taxIdAdditionalInfoKey } from "../deduce/deduce.js";
import { upsertFieldMapping } from "../repos/mappingRepo.js";

export interface DeducedSeedRow {
  readonly source_db: string;
  readonly source_table: string;
  readonly source_column: string;
  readonly destination_domain: DestinationDomain;
  readonly destination_field?: string | null;
  readonly confidence?: Confidence | "unmapped";
  readonly note?: string;
}

/**
 * source_db/source_table pairs excluded from the mapping registry entirely.
 * cr/progress is the scraper's internal progress cursor, not a lead record.
 */
const EXCLUDED_SOURCE_TABLES: ReadonlySet<string> = new Set(["cr/progress"]);

export function parseDeducedSeedRows(json: string): DeducedSeedRow[] {
  const rows = JSON.parse(json) as DeducedSeedRow[];
  return rows.filter(
    (row) => !EXCLUDED_SOURCE_TABLES.has(`${row.source_db}/${row.source_table}`),
  );
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

function deriveAdditionalInfoKey(row: DeducedSeedRow): string | null {
  if ((row.destination_field ?? null) !== "additionalInfo") {
    return null;
  }
  return taxIdAdditionalInfoKey(row.source_column);
}

export interface LoadDeducedSeedResult {
  readonly totalRows: number;
  readonly appliedCount: number;
  readonly skippedAdminCount: number;
}

/**
 * Loads the committed 832-row deduced dataset into field_mappings with
 * origin='seed'. Idempotent: reruns UPSERT through the shared mappingRepo,
 * so a row an admin has since edited (origin='admin') is never overwritten,
 * and rerunning against an already-seeded database does not duplicate rows.
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
