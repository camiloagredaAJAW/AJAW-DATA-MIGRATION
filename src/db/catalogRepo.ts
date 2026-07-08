import type Database from "better-sqlite3";
import { mapRowKeysToCamelCase } from "./sqlRowMapping.js";

export interface SourceCatalogRow {
  readonly id: number;
  readonly sourceDb: string;
  readonly sourceTable: string;
  readonly countryCode: string | null;
  readonly lastSampledAt: string | null;
  readonly sampledRowCount: number | null;
}

function mapSqlRowToSourceCatalogRow(row: Record<string, unknown>): SourceCatalogRow {
  return mapRowKeysToCamelCase<SourceCatalogRow>(row);
}

/**
 * Lists every source_catalog row, ordered by source_db, for the admin
 * Source Catalog page. This table has one row per (source_db, source_table)
 * pair — effectively one per country — so no filtering/pagination is needed.
 */
export function listSourceCatalog(db: Database.Database): SourceCatalogRow[] {
  const rows = db
    .prepare(`SELECT * FROM source_catalog ORDER BY source_db`)
    .all() as Record<string, unknown>[];

  return rows.map(mapSqlRowToSourceCatalogRow);
}
