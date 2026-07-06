import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun, updateRunStatus } from "../../src/db/runsRepo.js";

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
