import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { cleanupOrphanedRuns } from "../../src/api/server.js";
import { createRun, updateRunStatus, getRunById } from "../../src/db/runsRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
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
