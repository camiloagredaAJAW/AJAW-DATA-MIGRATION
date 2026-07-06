import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../../src/db/migrate.js";
import { buildServer } from "../../../src/api/server.js";
import type { AuthConfig } from "../../../src/api/auth/authGuard.js";
import type { MigrationControlDeps } from "../../../src/api/routes/migrationControl.js";
import type { AxelorConfig } from "../../../src/config/env.js";
import type { LeadsClientConfig } from "../../../src/leads/leadsClient.js";
import type { AxelorSessionClient } from "../../../src/axelor/sessionClient.js";
import type { MigrationEngineDeps, MigrationSummary } from "../../../src/migration/engine.js";
import { createRun, getRunById, updateRunStatus, getActiveRun } from "../../../src/db/runsRepo.js";
import { advanceOffset, getByRunCountry, upsertCheckpoint } from "../../../src/db/checkpointRepo.js";
import { recordError } from "../../../src/db/importErrorRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

const authConfig: AuthConfig = {
  username: "admin",
  password: "s3cret",
  internalApiKey: "internal-key-123",
};

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function validHeaders(): Record<string, string> {
  return {
    authorization: basicAuthHeader(authConfig.username, authConfig.password),
    "x-internal-api-key": authConfig.internalApiKey,
  };
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function fakeAxelorConfig(): AxelorConfig {
  return {
    baseUrl: "http://axelor.example.test",
    username: "admin",
    password: "secret",
    namespace: "com.ajaw",
    modelNameCompanies: "AiSearchResults",
  };
}

function fakeLeadsConfig(): LeadsClientConfig {
  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    companiesPath: "companies",
    keyValue: "ajaw_live_2026",
  };
}

function fakeSession(): AxelorSessionClient {
  return {
    getSession: vi
      .fn()
      .mockResolvedValue({ authHeader: "Basic xyz", cookieHeader: "JSESSIONID=abc" }),
    invalidate: vi.fn(),
  };
}

function fakeMigrationDeps(db: Database.Database): MigrationControlDeps {
  return {
    db,
    leadsConfig: fakeLeadsConfig(),
    axelorConfig: fakeAxelorConfig(),
    pageLimit: 100,
    session: fakeSession(),
  };
}

/**
 * A fake `runMigrationFn` that resolves immediately with an empty summary —
 * used whenever a test only cares about the route's synchronous behavior
 * (status transitions, 409s), not the in-flight engine execution itself.
 */
function resolvedRunMigrationFn(): (deps: MigrationEngineDeps) => Promise<MigrationSummary> {
  return async (deps) => ({ runId: deps.runId as number, countries: [] });
}

/**
 * A controllable fake `runMigrationFn` that blocks until the test explicitly
 * calls `release()` — simulating an in-flight engine execution (e.g. blocked
 * mid-page on a Leads DB fetch) without running the real, multi-minute
 * engine. Mirrors the design's test-strategy for "start then pause
 * mid-flight".
 */
function controllableRunMigrationFn(): {
  fn: (deps: MigrationEngineDeps) => Promise<MigrationSummary>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    fn: async (deps) => {
      await gate;
      return { runId: deps.runId as number, countries: [] };
    },
    release,
  };
}

/** Lets any already-scheduled microtasks (fire-and-forget promise chains) settle before a test ends. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("POST /api/migration/start", () => {
  it("creates a new run and starts engine execution when none is active", async () => {
    const db = freshDb();
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/start",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(typeof body.data.runId).toBe("number");
    expect(body.data.status).toBe("running");
    expect(getActiveRun(db)?.id).toBe(body.data.runId);
    await flushMicrotasks();
  });

  it("returns 409 when a run is already running", async () => {
    const db = freshDb();
    createRun(db);
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/start",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });

  it("returns 409 when a run is already paused", async () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "paused");
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/start",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });

  it("rejects requests without auth", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "POST", url: "/api/migration/start" });

    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/migration/pause", () => {
  it("pauses a running run", async () => {
    const db = freshDb();
    const run = createRun(db);
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/pause",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("paused");
    expect(getRunById(db, run.id)?.status).toBe("paused");
  });

  it("returns 409 when no run is active", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/pause",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });

  it("returns 409 when the active run is already paused", async () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "paused");
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/pause",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expect(getRunById(db, run.id)?.status).toBe("paused");
  });

  it("rejects requests without auth", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "POST", url: "/api/migration/pause" });

    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/migration/resume", () => {
  it("resumes a paused run and re-invokes the engine with the same runId", async () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "paused");
    const fn = vi.fn(resolvedRunMigrationFn());
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: fn,
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/resume",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data.status).toBe("running");
    expect(getRunById(db, run.id)?.status).toBe("running");
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }));
    await flushMicrotasks();
  });

  it("returns 409 when no run has ever started", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/resume",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });

  it("returns 409 when the active run is running, not paused", async () => {
    const db = freshDb();
    createRun(db);
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/resume",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });

  it("returns 409 when the most recent run is stopped", async () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "stopped");
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/resume",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });

  it("rejects requests without auth", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "POST", url: "/api/migration/resume" });

    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/migration/stop", () => {
  it("stops a running run (terminal)", async () => {
    const db = freshDb();
    const run = createRun(db);
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/stop",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("stopped");
    expect(getRunById(db, run.id)?.status).toBe("stopped");
  });

  it("stops a paused run", async () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "paused");
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/stop",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(getRunById(db, run.id)?.status).toBe("stopped");
  });

  it("returns 409 when no active run exists", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/stop",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });

  it("rejects a second stop call once already stopped", async () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "stopped");
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/stop",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expect(getRunById(db, run.id)?.status).toBe("stopped");
  });

  it("rejects requests without auth", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "POST", url: "/api/migration/stop" });

    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/migration/status", () => {
  it("returns a null-run indicator with 200 when no run has ever started", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "GET",
      url: "/api/migration/status",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.run).toBeNull();
    expect(body.checkpoints).toEqual([]);
    expect(body.totals.errors).toBe(0);
  });

  it("returns the active run's status, per-country checkpoints, and import_errors count", async () => {
    const db = freshDb();
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "ar");
    advanceOffset(db, checkpoint.id, 250);
    recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 10,
      recordIdentifier: "ACME",
      errorReason: "boom",
    });
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({
      method: "GET",
      url: "/api/migration/status",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.run.id).toBe(run.id);
    expect(body.run.status).toBe("running");
    expect(body.checkpoints).toHaveLength(1);
    expect(body.checkpoints[0].countryCode).toBe("ar");
    expect(body.checkpoints[0].lastOffset).toBe(250);
    expect(body.totals.errors).toBe(1);
  });

  it("rejects requests without auth", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig, migrationDeps: fakeMigrationDeps(db) });

    const response = await server.inject({ method: "GET", url: "/api/migration/status" });

    expect(response.statusCode).toBe(401);
  });
});

describe("lifecycle", () => {
  it("start then pause mid-flight halts the active run without waiting for the engine to finish", async () => {
    const db = freshDb();
    const { fn, release } = controllableRunMigrationFn();
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: fn,
    });

    const startResponse = await server.inject({
      method: "POST",
      url: "/api/migration/start",
      headers: validHeaders(),
    });
    expect(startResponse.statusCode).toBe(202);
    const runId = startResponse.json().data.runId as number;
    // The fake engine is still blocked on its gate — status stays "running".
    expect(getRunById(db, runId)?.status).toBe("running");

    const pauseResponse = await server.inject({
      method: "POST",
      url: "/api/migration/pause",
      headers: validHeaders(),
    });

    expect(pauseResponse.statusCode).toBe(200);
    expect(pauseResponse.json().data.status).toBe("paused");
    expect(getRunById(db, runId)?.status).toBe("paused");

    release();
    await flushMicrotasks();
  });

  it("stop then start creates a brand-new run and leaves the prior run's checkpoints untouched", async () => {
    const db = freshDb();
    const firstRun = createRun(db);
    const checkpoint = upsertCheckpoint(db, firstRun.id, "ar");
    advanceOffset(db, checkpoint.id, 500);
    updateRunStatus(db, firstRun.id, "stopped");
    const server = buildServer({
      db,
      authConfig,
      migrationDeps: fakeMigrationDeps(db),
      runMigrationFn: resolvedRunMigrationFn(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/migration/start",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(202);
    const newRunId = response.json().data.runId as number;
    expect(newRunId).not.toBe(firstRun.id);
    // Routes never touch checkpoints directly — the prior run's persisted
    // AR offset is untouched here. The engine (see engine.test.ts) is what
    // actually reuses `last_offset` once it processes AR under the new run.
    expect(getByRunCountry(db, firstRun.id, "ar")?.lastOffset).toBe(500);
    await flushMicrotasks();
  });
});
