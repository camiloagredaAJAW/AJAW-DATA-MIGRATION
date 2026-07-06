import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun, updateRunStatus, getActiveRun } from "../../src/db/runsRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

describe("createRun", () => {
  it("inserts a migration_runs row with status='running' and returns it", () => {
    const db = freshDb();

    const run = createRun(db);

    expect(run.id).toBeGreaterThan(0);
    expect(run.status).toBe("running");
    expect(typeof run.startedAt).toBe("string");
    expect(typeof run.updatedAt).toBe("string");

    const row = db.prepare(`SELECT * FROM migration_runs WHERE id = ?`).get(run.id) as
      | Record<string, unknown>
      | undefined;
    expect(row?.status).toBe("running");
  });
});

describe("updateRunStatus", () => {
  it("updates the status and updated_at of an existing run", () => {
    const db = freshDb();
    const run = createRun(db);

    const updated = updateRunStatus(db, run.id, "completed");

    expect(updated?.status).toBe("completed");
    const row = db.prepare(`SELECT * FROM migration_runs WHERE id = ?`).get(run.id) as
      | Record<string, unknown>
      | undefined;
    expect(row?.status).toBe("completed");
  });

  it("returns null for a non-existent run id and changes nothing", () => {
    const db = freshDb();

    const updated = updateRunStatus(db, 999999, "completed");

    expect(updated).toBeNull();
  });

  it("rejects an invalid status via the CHECK constraint", () => {
    const db = freshDb();
    const run = createRun(db);

    expect(() => updateRunStatus(db, run.id, "bogus" as never)).toThrowError(
      /CHECK constraint failed/,
    );
  });
});

describe("getActiveRun", () => {
  it("returns null when no run has ever been created", () => {
    const db = freshDb();

    expect(getActiveRun(db)).toBeNull();
  });

  it("returns the run when its status is running", () => {
    const db = freshDb();
    const run = createRun(db);

    const active = getActiveRun(db);

    expect(active?.id).toBe(run.id);
    expect(active?.status).toBe("running");
  });

  it("returns the run when its status is paused", () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "paused");

    const active = getActiveRun(db);

    expect(active?.id).toBe(run.id);
    expect(active?.status).toBe("paused");
  });

  it("returns null when the most recent run is completed, stopped, or failed", () => {
    const db = freshDb();
    const run = createRun(db);
    updateRunStatus(db, run.id, "completed");

    expect(getActiveRun(db)).toBeNull();
  });

  it("returns the most recent active run when multiple runs exist", () => {
    const db = freshDb();
    const first = createRun(db);
    updateRunStatus(db, first.id, "stopped");
    const second = createRun(db);

    const active = getActiveRun(db);

    expect(active?.id).toBe(second.id);
  });
});
