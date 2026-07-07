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
import { createMigrationController } from "../migration/controller.js";
import { adminPlugin } from "./admin/adminPlugin.js";
import type { MigrationEngineDeps, MigrationSummary } from "../migration/engine.js";
import { buildMigrationDeps } from "../cli/migrate.js";
import { updateRunStatus } from "../db/runsRepo.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface BuildServerOptions {
  readonly db: Database.Database;
  readonly authConfig: AuthConfig;
  /**
   * Migration engine dependencies. When omitted, the `/api/migration/*`
   * control routes are not registered at all (e.g. a deployment that only
   * needs the field_mappings API). `main()` always builds and passes these
   * from env config via `buildMigrationDeps` (reused from `cli/migrate.ts`);
   * this stays optional so tests and field_mappings-only deployments can omit
   * it.
   */
  readonly migrationDeps?: MigrationControlDeps;
  /** Injectable engine invocation for the migration control routes. Defaults to the real `runMigration`. */
  readonly runMigrationFn?: (deps: MigrationEngineDeps) => Promise<MigrationSummary>;
}

/**
 * Builds the Fastify instance with the `/api/*` routes (field_mappings and
 * the optional migration-control routes) encapsulated in their own plugin
 * context. The auth guard's `onRequest` hook is registered INSIDE that same
 * `register()` callback, WITHOUT a `{prefix}` option: `registerFieldMappingsRoutes`
 * and `registerMigrationControlRoutes` already hardcode `/api/...` in every
 * route path, so a prefix would double it to `/api/api/...`. Fastify's plugin
 * encapsulation alone confines the hook to this context — it never leaks to
 * sibling scopes (e.g. the `/admin/*` session-cookie scope registered
 * alongside it), while route paths stay unchanged. Not started here —
 * callers decide whether to `.listen()` (real server) or use `.inject()`
 * (tests).
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  // Silenced under `vitest run` (NODE_ENV=test) to keep test output clean;
  // the /admin auth guard relies on request.log.warn for brute-force/CSRF
  // visibility, which is a no-op without a real logger instance.
  const fastify = Fastify({ logger: process.env.NODE_ENV !== "test" });
  // Built once here (not inside registerMigrationControlRoutes) so a future
  // `/admin/*` scope can share this exact instance instead of running a
  // second, independent registry against the same DB.
  const controller =
    options.migrationDeps !== undefined
      ? createMigrationController(options.db, options.migrationDeps, {
          runMigrationFn: options.runMigrationFn,
        })
      : undefined;

  fastify.register(async (api) => {
    registerAuthGuard(api, options.authConfig);
    registerFieldMappingsRoutes(api, options.db);
    if (controller !== undefined) {
      registerMigrationControlRoutes(api, controller);
    }
  });
  // Sibling scope: its own session-cookie auth, entirely separate from the
  // /api Basic Auth guard above (see spec "Admin session does not unlock API
  // scope" / "API credentials do not unlock admin scope").
  fastify.register(adminPlugin, { db: options.db, authConfig: options.authConfig, controller });
  return fastify;
}

/**
 * Transitions every `migration_runs` row still marked `'running'` to
 * `'failed'`. Intended to run once, before the server starts accepting
 * requests: the in-process controller registry is always empty right after a
 * fresh process start, so any `'running'` row at that point is definitionally
 * orphaned — no live controller can exist yet to finish it. A `'paused'` run
 * is left untouched: it is a valid resumable state that survives a server
 * restart, unlike `'running'`, which implies an in-process loop that no
 * longer exists.
 *
 * Returns the ids of the runs that were transitioned, for observability.
 */
export function cleanupOrphanedRuns(db: Database.Database): number[] {
  const orphaned = db
    .prepare(`SELECT id FROM migration_runs WHERE status = 'running'`)
    .all() as { id: number }[];

  for (const { id } of orphaned) {
    updateRunStatus(db, id, "failed");
  }

  return orphaned.map((row) => row.id);
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

  const orphaned = cleanupOrphanedRuns(db);
  if (orphaned.length > 0) {
    console.warn(
      `Marked ${orphaned.length} orphaned 'running' migration run(s) as 'failed' on startup: ${orphaned.join(", ")}`,
    );
  }

  const migrationDeps = buildMigrationDeps(db);
  const server = buildServer({ db, authConfig, migrationDeps });

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
