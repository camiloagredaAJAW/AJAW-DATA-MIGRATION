import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "dotenv/config";
import type Database from "better-sqlite3";
import { openConnection } from "../db/connection.js";
import { loadAxelorConfig, loadLeadsPageConfig } from "../config/env.js";
import { createSessionClient, type AxelorSessionClient } from "../axelor/sessionClient.js";
import { runMigration, type MigrationEngineDeps, type MigrationSummary } from "../migration/engine.js";
import type { LeadsClientConfig } from "../leads/leadsClient.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readLeadsConfigFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): LeadsClientConfig {
  const baseUrl = env.LEADS_DB_BASE_URL;
  const keyValue = env.LEADS_DB_QP_KEY_VALUE;
  if (!baseUrl || !keyValue) {
    throw new Error(
      "LEADS_DB_BASE_URL and LEADS_DB_QP_KEY_VALUE must be set to run the migration engine",
    );
  }
  return {
    baseUrl,
    dbsPath: env.LEADS_DB_ALL ?? "dbs",
    companiesPath: env.LEADS_DB_EXPORT ?? "companies",
    keyValue,
    fetchImpl,
  };
}

export interface BuildMigrationDepsOptions {
  /** Injectable env record, defaults to `process.env`. Lets tests avoid mutating global state. */
  readonly env?: Record<string, string | undefined>;
  /** Injectable fetch for the Leads DB client. Defaults to the global fetch. */
  readonly leadsFetchImpl?: typeof fetch;
  /** Injectable fetch for Axelor REST calls. Defaults to the global fetch. */
  readonly axelorFetchImpl?: typeof fetch;
  /** Injectable session-client factory, defaults to `createSessionClient`. */
  readonly sessionClientFactory?: (
    axelorConfig: ReturnType<typeof loadAxelorConfig>,
    fetchImpl?: typeof fetch,
  ) => AxelorSessionClient;
}

/**
 * Wires the migration engine's dependencies from environment config: Axelor
 * connection + namespace, the Leads DB pagination page size, a fresh Axelor
 * session client, and the Leads DB client config. Every piece is injectable
 * so this can be exercised in tests without touching the network or reading
 * real process.env.
 */
export function buildMigrationDeps(
  db: Database.Database,
  options: BuildMigrationDepsOptions = {},
): Omit<MigrationEngineDeps, "countries" | "runId"> {
  const env = options.env ?? process.env;
  const axelorConfig = loadAxelorConfig(env);
  const { pageLimit } = loadLeadsPageConfig(env);
  const leadsConfig = readLeadsConfigFromEnv(env, options.leadsFetchImpl);
  const sessionFactory = options.sessionClientFactory ?? createSessionClient;
  const session = sessionFactory(axelorConfig, options.axelorFetchImpl);

  return {
    db,
    leadsConfig,
    axelorConfig,
    pageLimit,
    session,
    fetchImpl: options.axelorFetchImpl,
  };
}

export interface RunMigrationCliOptions extends BuildMigrationDepsOptions {
  readonly countries?: readonly string[];
  readonly runId?: number;
}

/** Builds the engine deps from env config and runs (or resumes) a migration. */
export async function runMigrationCli(
  db: Database.Database,
  options: RunMigrationCliOptions = {},
): Promise<MigrationSummary> {
  const deps = buildMigrationDeps(db, options);
  return runMigration({ ...deps, countries: options.countries, runId: options.runId });
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
      case "run": {
        const countries = typeof flags.country === "string" ? [flags.country] : undefined;
        const summary = await runMigrationCli(db, { countries });
        console.log(`Migration run ${summary.runId} complete:`);
        for (const country of summary.countries) {
          console.log(
            `  ${country.countryCode}: ${country.status} ` +
              `(${country.processedCount} processed, ${country.failedCount} failed)`,
          );
        }
        break;
      }
      default: {
        console.error(`Unknown command "${command}". Expected: run [--country <CODE>]`);
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
