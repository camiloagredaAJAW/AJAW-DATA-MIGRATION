import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "dotenv/config";
import type Database from "better-sqlite3";
import { openConnection } from "../db/connection.js";
import { migrate, type MigrateResult } from "../db/migrate.js";
import { loadDeducedSeed, type LoadDeducedSeedResult } from "../seed/loadDeduced.js";
import { deduce, type DestinationDomain } from "../deduce/deduce.js";
import { upsertFieldMapping } from "../repos/mappingRepo.js";
import {
  fetchCatalog,
  sampleCountries,
  type LeadsClientConfig,
  type LeadsCatalogEntry,
} from "../leads/leadsClient.js";

/**
 * The Leads DB now only exposes company data — every sampled column deduces
 * against this single domain unconditionally (see `deduce.ts`).
 */
const DESTINATION_DOMAIN: DestinationDomain = "AiSearchResults";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_MIGRATIONS_DIR = path.join(REPO_ROOT, "src", "migrations");
const DEFAULT_SEED_JSON_PATH = path.join(
  REPO_ROOT,
  "references",
  "leads-mapping",
  "field-mappings.deduced.json",
);
const DEFAULT_SAMPLE_LIMIT = 3;

export function runMigrate(db: Database.Database, migrationsDir: string): MigrateResult {
  return migrate(db, migrationsDir);
}

export function runSeed(db: Database.Database, seedJsonPath: string): LoadDeducedSeedResult {
  return loadDeducedSeed(db, seedJsonPath);
}

export interface RefreshCatalogResult {
  readonly totalCatalogEntries: number;
  readonly newPairs: LeadsCatalogEntry[];
}

/**
 * Refreshes `source_catalog` from the live Leads DB `/dbs` endpoint.
 * CLI-only per design — there is no HTTP refresh endpoint in this slice.
 */
export async function runRefreshCatalog(
  db: Database.Database,
  leadsConfig: LeadsClientConfig,
): Promise<RefreshCatalogResult> {
  const entries = await fetchCatalog(leadsConfig);

  const existingPairs = new Set(
    (
      db.prepare(`SELECT source_db, source_table FROM source_catalog`).all() as {
        source_db: string;
        source_table: string;
      }[]
    ).map((row) => `${row.source_db}/${row.source_table}`),
  );

  const newPairs: LeadsCatalogEntry[] = [];
  const now = new Date().toISOString();
  const upsertCatalog = db.prepare(`
    INSERT INTO source_catalog (source_db, source_table, last_sampled_at)
    VALUES (@sourceDb, @sourceTable, @now)
    ON CONFLICT(source_db, source_table) DO UPDATE SET last_sampled_at = excluded.last_sampled_at
  `);

  const applyAll = db.transaction((catalogEntries: LeadsCatalogEntry[]) => {
    for (const entry of catalogEntries) {
      const key = `${entry.sourceDb}/${entry.sourceTable}`;
      if (!existingPairs.has(key)) {
        newPairs.push(entry);
      }
      upsertCatalog.run({ sourceDb: entry.sourceDb, sourceTable: entry.sourceTable, now });
    }
  });
  applyAll(entries);

  return { totalCatalogEntries: entries.length, newPairs };
}

export interface SampleOptions {
  readonly sourceDb?: string;
  readonly sourceTable?: string;
  readonly limit?: number;
}

export interface SampleRunResult {
  readonly processedTables: number;
  readonly appliedMappings: number;
  readonly skippedAdminMappings: number;
  readonly failedTables: { sourceDb: string; sourceTable: string; error: string }[];
}

/**
 * Re-samples live countries from the catalog (optionally filtered to a
 * single source_db/source_table pair — sourceDb is a country code,
 * sourceTable is always `"companies"`) and re-runs deduction to insert any
 * genuinely new columns. Never updates a row that already exists for a
 * given triple — regardless of its origin (admin, seed, or bootstrap) —
 * that guarantee comes from mappingRepo.upsertFieldMapping, used for every
 * write. A country returning 0 rows is skipped: no rows are created or
 * deleted for it.
 */
export async function runSample(
  db: Database.Database,
  leadsConfig: LeadsClientConfig,
  options: SampleOptions = {},
): Promise<SampleRunResult> {
  const catalogRows = db
    .prepare(
      `SELECT source_db, source_table FROM source_catalog
       WHERE (@sourceDb IS NULL OR source_db = @sourceDb)
         AND (@sourceTable IS NULL OR source_table = @sourceTable)`,
    )
    .all({
      sourceDb: options.sourceDb ?? null,
      sourceTable: options.sourceTable ?? null,
    }) as { source_db: string; source_table: string }[];

  const pairs: LeadsCatalogEntry[] = catalogRows.map((row) => ({
    sourceDb: row.source_db,
    sourceTable: row.source_table,
  }));

  const outcomes = await sampleCountries(leadsConfig, pairs, options.limit ?? DEFAULT_SAMPLE_LIMIT);

  let appliedMappings = 0;
  let skippedAdminMappings = 0;
  const failedTables: SampleRunResult["failedTables"] = [];

  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      failedTables.push({
        sourceDb: outcome.sourceDb,
        sourceTable: outcome.sourceTable,
        error: outcome.error,
      });
      continue;
    }

    if (outcome.rows.length === 0) {
      continue;
    }

    const columns = new Set<string>();
    for (const row of outcome.rows) {
      for (const column of Object.keys(row)) {
        columns.add(column);
      }
    }

    for (const column of columns) {
      const deduced = deduce(column, outcome.rows);
      const result = upsertFieldMapping(db, {
        sourceDb: outcome.sourceDb,
        sourceTable: outcome.sourceTable,
        sourceColumn: column,
        destinationDomain: DESTINATION_DOMAIN,
        destinationField: deduced.destinationField,
        additionalInfoKey: deduced.additionalInfoKey,
        confidence: deduced.confidence,
        note: null,
        origin: "bootstrap",
      });
      if (result.applied) {
        appliedMappings += 1;
      } else {
        skippedAdminMappings += 1;
      }
    }
  }

  return {
    processedTables: outcomes.length,
    appliedMappings,
    skippedAdminMappings,
    failedTables,
  };
}

function readLeadsConfigFromEnv(): LeadsClientConfig {
  const baseUrl = process.env.LEADS_DB_BASE_URL;
  const keyValue = process.env.LEADS_DB_QP_KEY_VALUE;
  if (!baseUrl || !keyValue) {
    throw new Error(
      "LEADS_DB_BASE_URL and LEADS_DB_QP_KEY_VALUE must be set to sample the live Leads DB",
    );
  }
  return {
    baseUrl,
    dbsPath: process.env.LEADS_DB_ALL ?? "dbs",
    companiesPath: process.env.LEADS_DB_EXPORT ?? "companies",
    keyValue,
  };
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg?.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command: command ?? "", flags };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dbPath = process.env.SQLITE_PATH ?? path.join(REPO_ROOT, "data", "mapping.db");
  const db = openConnection(dbPath);

  try {
    switch (command) {
      case "migrate": {
        const result = runMigrate(db, DEFAULT_MIGRATIONS_DIR);
        console.log(`Applied migrations: ${result.appliedVersions.join(", ") || "none pending"}`);
        break;
      }
      case "seed": {
        const result = runSeed(db, DEFAULT_SEED_JSON_PATH);
        console.log(
          `Seed load complete: ${result.totalRows} rows processed, ${result.appliedCount} applied, ${result.skippedAdminCount} skipped (already existed).`,
        );
        break;
      }
      case "refresh-catalog": {
        const result = await runRefreshCatalog(db, readLeadsConfigFromEnv());
        console.log(
          `Catalog refreshed: ${result.totalCatalogEntries} pairs total, ${result.newPairs.length} newly discovered.`,
        );
        break;
      }
      case "sample": {
        if (flags.refresh !== true) {
          console.error(
            'The "sample" command hits the live Leads DB — pass --refresh to confirm (e.g. `sample --refresh --db BR --table companies`).',
          );
          process.exitCode = 1;
          break;
        }
        const result = await runSample(db, readLeadsConfigFromEnv(), {
          sourceDb: typeof flags.db === "string" ? flags.db : undefined,
          sourceTable: typeof flags.table === "string" ? flags.table : undefined,
        });
        console.log(
          `Sample run complete: ${result.processedTables} tables processed, ${result.appliedMappings} mappings applied, ${result.skippedAdminMappings} skipped (already existed), ${result.failedTables.length} tables failed.`,
        );
        if (result.failedTables.length > 0) {
          console.warn("Failed tables:", result.failedTables);
        }
        break;
      }
      default: {
        console.error(
          `Unknown command "${command}". Expected one of: migrate, seed, refresh-catalog, sample [--db --table]`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    db.close();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
