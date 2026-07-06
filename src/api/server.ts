import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { openConnection } from "../db/connection.js";
import { registerAuthGuard, type AuthConfig } from "./auth/authGuard.js";
import { registerFieldMappingsRoutes } from "./routes/fieldMappings.js";
import {
  registerMigrationControlRoutes,
  type MigrationControlDeps,
} from "./routes/migrationControl.js";
import type { MigrationEngineDeps, MigrationSummary } from "../migration/engine.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface BuildServerOptions {
  readonly db: Database.Database;
  readonly authConfig: AuthConfig;
  /**
   * Migration engine dependencies. When omitted, the `/api/migration/*`
   * control routes are not registered at all (e.g. a deployment that only
   * needs the field_mappings API). Real server startup wiring (env-based
   * deps + the startup orphaned-run cleanup hook) lands in a later slice.
   */
  readonly migrationDeps?: MigrationControlDeps;
  /** Injectable engine invocation for the migration control routes. Defaults to the real `runMigration`. */
  readonly runMigrationFn?: (deps: MigrationEngineDeps) => Promise<MigrationSummary>;
}

/**
 * Builds the Fastify instance with the auth guard registered before the
 * field_mappings and (optional) migration-control routes, so every route
 * requires Basic Auth + the internal API key. Not started here — callers
 * decide whether to `.listen()` (real server) or use `.inject()` (tests).
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerAuthGuard(fastify, options.authConfig);
  registerFieldMappingsRoutes(fastify, options.db);
  if (options.migrationDeps !== undefined) {
    registerMigrationControlRoutes(fastify, options.db, options.migrationDeps, {
      runMigrationFn: options.runMigrationFn,
    });
  }
  return fastify;
}

function readAuthConfigFromEnv(): AuthConfig {
  const username = process.env.AXELOR_USERNAME;
  const password = process.env.AXELOR_PASSWORD;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (!username || !password || !internalApiKey) {
    throw new Error(
      "AXELOR_USERNAME, AXELOR_PASSWORD, and INTERNAL_API_KEY must be set to start the API server",
    );
  }
  return { username, password, internalApiKey };
}

async function main(): Promise<void> {
  const dbPath = process.env.SQLITE_PATH ?? path.join(REPO_ROOT, "data", "mapping.db");
  const db = openConnection(dbPath);
  const authConfig = readAuthConfigFromEnv();
  const server = buildServer({ db, authConfig });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await server.listen({ port, host: "0.0.0.0" });
  console.log(`Mapping registry API listening on port ${port}`);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
