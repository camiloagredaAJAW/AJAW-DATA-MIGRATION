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
 * Refreshes `source_catalog` from the live Leads DB `/dbs` endpoint. Also
 * exposed over HTTP via `MigrationController.refreshCatalog` (see
 * `POST /admin/api/catalog/refresh` in `adminBffRoutes.ts`), not just the CLI.
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

export interface FullResetResult {
  readonly seed: LoadDeducedSeedResult;
  readonly catalog: RefreshCatalogResult;
}

/**
 * "Reset Everything": wipes ALL operational state — migration_runs,
 * migration_checkpoints, import_errors, field_mappings, source_catalog — then
 * re-populates field_mappings from the committed seed dataset and
 * source_catalog from the live Leads DB, in one step. Collapses what the
 * project owner had been doing manually (delete the SQLite file, `npm run
 * migrate`, `npm run seed`, click "Refresh Catalog") into a single call.
 * Exposed over HTTP as `POST /admin/api/reset` (see
 * `MigrationController.resetEverything` and its password re-check in
 * `adminPlugin.ts`), gated behind re-entering the admin password since this
 * is the single most destructive action in the app.
 *
 * DESTRUCTIVE AND IRREVERSIBLE: there is no soft-delete, no backup, and no
 * undo. The wipe itself runs inside one `db.transaction(...)` so a mid-wipe
 * failure (e.g. a constraint violation) leaves every table untouched instead
 * of partially emptied — but once that transaction commits, the deleted rows
 * are gone for good; nothing rolls back after this function returns.
 *
 * Deletion order matters: `import_errors` and `migration_checkpoints` both
 * carry `run_id INTEGER NOT NULL REFERENCES migration_runs(id)` (see
 * migrations 006/007), and `foreign_keys = ON` is set on every connection
 * (`db/connection.ts`), so both must be deleted before `migration_runs` or
 * SQLite rejects the delete. `field_mappings` and `source_catalog` have no FK
 * dependents, so their position in the list doesn't matter.
 *
 * The reseed happens AFTER the wipe transaction commits (not inside it):
 * `runSeed` and `runRefreshCatalog` already own their own transactional
 * writes and, for the catalog, an `await fetch(...)` to the live Leads DB —
 * neither belongs inside a synchronous `db.transaction(...)` callback, and
 * duplicating their insert/upsert logic here would risk drifting out of sync
 * with the single source of truth each already is.
 *
 * Because the reseed runs AFTER the wipe transaction has already committed,
 * a failure in `runSeed`/`runRefreshCatalog` at that point cannot be rolled
 * back: every table is left empty with no field mappings and no catalog.
 * That failure is caught here and rethrown as a single, self-describing
 * `Error` (rather than letting the original error propagate un-annotated)
 * specifically so whatever catches it next — currently `POST
 * /admin/api/reset` in `adminPlugin.ts` — doesn't have to know this
 * function's internals to explain the degraded state and the manual
 * recovery steps to an operator.
 */
export async function runFullReset(
  db: Database.Database,
  leadsConfig: LeadsClientConfig,
): Promise<FullResetResult> {
  const wipeAll = db.transaction(() => {
    db.prepare(`DELETE FROM import_errors`).run();
    db.prepare(`DELETE FROM migration_checkpoints`).run();
    db.prepare(`DELETE FROM migration_runs`).run();
    db.prepare(`DELETE FROM field_mappings`).run();
    db.prepare(`DELETE FROM source_catalog`).run();
  });
  wipeAll();

  try {
    const seed = runSeed(db, DEFAULT_SEED_JSON_PATH);
    const catalog = await runRefreshCatalog(db, leadsConfig);
    return { seed, catalog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Reset wiped all tables successfully, but re-seeding failed: ${message}. All operational data is currently empty — run 'npm run seed' and 'npm run refresh' (or the Refresh Catalog button) manually to recover.`,
    );
  }
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
