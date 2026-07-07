import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { buildServer, cleanupOrphanedRuns } from "../../src/api/server.js";
import { createRun, updateRunStatus, getRunById } from "../../src/db/runsRepo.js";
import type { AuthConfig } from "../../src/api/auth/authGuard.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

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

describe("cleanupOrphanedRuns", () => {
  it("transitions a 'running' run to 'failed' on startup, since the in-process registry is always empty at boot", () => {
    const db = freshDb();
    const run = createRun(db);

    const transitioned = cleanupOrphanedRuns(db);

    expect(transitioned).toEqual([run.id]);
    expect(getRunById(db, run.id)?.status).toBe("failed");
  });

  it("transitions every 'running' run when multiple exist", () => {
    const db = freshDb();
    const first = createRun(db);
    const second = createRun(db);

    const transitioned = cleanupOrphanedRuns(db);

    expect(transitioned.sort()).toEqual([first.id, second.id].sort());
    expect(getRunById(db, first.id)?.status).toBe("failed");
    expect(getRunById(db, second.id)?.status).toBe("failed");
  });

  it("does NOT touch a 'paused' run — it is a valid resumable state", () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "paused");

    const transitioned = cleanupOrphanedRuns(db);

    expect(transitioned).toEqual([]);
    expect(getRunById(db, run.id)?.status).toBe("paused");
  });

  it("does NOT touch completed/stopped/failed runs and returns an empty list when nothing is orphaned", () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "completed");

    const transitioned = cleanupOrphanedRuns(db);

    expect(transitioned).toEqual([]);
    expect(getRunById(db, run.id)?.status).toBe("completed");
  });
});

describe("buildServer /api scope encapsulation", () => {
  it("still rejects /api/* requests without auth (behavior-preserving)", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({ method: "GET", url: "/api/field-mappings" });

    expect(response.statusCode).toBe(401);
  });

  it("still accepts /api/* requests with valid auth (behavior-preserving)", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({
      method: "GET",
      url: "/api/field-mappings",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
  });

  it("does not leak the /api Basic Auth guard onto a sibling route registered outside the /api scope", async () => {
    const db = freshDb();
    const server = buildServer({ db, authConfig });
    server.get("/sibling-outside-api-scope", async () => ({ ok: true }));
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/sibling-outside-api-scope" });

    expect(response.statusCode).toBe(200);
  });
});
