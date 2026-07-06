import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun } from "../../src/db/runsRepo.js";
import {
  advanceOffset,
  getByRunCountry,
  listByRun,
  setAiSearchId,
  setStatus,
  upsertCheckpoint,
} from "../../src/db/checkpointRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

describe("upsertCheckpoint", () => {
  it("creates a pending checkpoint with last_offset=0 for a new (run_id, country_code) pair", () => {
    const db = freshDb();
    const run = createRun(db);

    const checkpoint = upsertCheckpoint(db, run.id, "ar");

    expect(checkpoint.runId).toBe(run.id);
    expect(checkpoint.countryCode).toBe("ar");
    expect(checkpoint.lastOffset).toBe(0);
    expect(checkpoint.status).toBe("pending");
    expect(checkpoint.aiSearchId).toBeNull();
  });

  it("is idempotent: calling again for the same (run_id, country_code) returns the existing row unchanged", () => {
    const db = freshDb();
    const run = createRun(db);
    const first = upsertCheckpoint(db, run.id, "ar");
    advanceOffset(db, first.id, 50);
    setAiSearchId(db, first.id, 123);

    const second = upsertCheckpoint(db, run.id, "ar");

    expect(second.id).toBe(first.id);
    expect(second.lastOffset).toBe(50);
    expect(second.aiSearchId).toBe(123);
  });

  it("enforces UNIQUE(run_id, country_code) at the raw insert level", () => {
    const db = freshDb();
    const run = createRun(db);
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO migration_checkpoints
        (run_id, country_code, last_offset, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(run.id, "ar", 0, "pending", now, now);

    expect(() => insert.run(run.id, "ar", 0, "pending", now, now)).toThrowError(
      /UNIQUE constraint failed/,
    );
  });
});

describe("getByRunCountry", () => {
  it("returns the checkpoint for an existing (run_id, country_code) pair", () => {
    const db = freshDb();
    const run = createRun(db);
    upsertCheckpoint(db, run.id, "ar");

    const found = getByRunCountry(db, run.id, "ar");

    expect(found?.countryCode).toBe("ar");
  });

  it("returns null when no checkpoint exists for the pair", () => {
    const db = freshDb();
    const run = createRun(db);

    const found = getByRunCountry(db, run.id, "cl");

    expect(found).toBeNull();
  });
});

describe("advanceOffset", () => {
  it("sets last_offset to the given value", () => {
    const db = freshDb();
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "ar");

    const updated = advanceOffset(db, checkpoint.id, 25);

    expect(updated?.lastOffset).toBe(25);
  });

  it("returns null for a non-existent checkpoint id", () => {
    const db = freshDb();

    const updated = advanceOffset(db, 999999, 25);

    expect(updated).toBeNull();
  });
});

describe("setAiSearchId", () => {
  it("persists the AiSearch parent id on the checkpoint", () => {
    const db = freshDb();
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "ar");

    const updated = setAiSearchId(db, checkpoint.id, 456);

    expect(updated?.aiSearchId).toBe(456);
  });
});

describe("listByRun", () => {
  it("returns every checkpoint for a run, ordered by country_code", () => {
    const db = freshDb();
    const run = createRun(db);
    upsertCheckpoint(db, run.id, "cl");
    upsertCheckpoint(db, run.id, "ar");

    const found = listByRun(db, run.id);

    expect(found).toHaveLength(2);
    expect(found.map((row) => row.countryCode)).toEqual(["ar", "cl"]);
  });

  it("returns an empty array when the run has no checkpoints yet", () => {
    const db = freshDb();
    const run = createRun(db);

    const found = listByRun(db, run.id);

    expect(found).toEqual([]);
  });

  it("does not return checkpoints belonging to a different run", () => {
    const db = freshDb();
    const runA = createRun(db);
    const runB = createRun(db);
    upsertCheckpoint(db, runA.id, "ar");
    upsertCheckpoint(db, runB.id, "cl");

    const found = listByRun(db, runA.id);

    expect(found).toHaveLength(1);
    expect(found[0]?.countryCode).toBe("ar");
  });
});

describe("setStatus", () => {
  it("updates the checkpoint status", () => {
    const db = freshDb();
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "ar");

    const updated = setStatus(db, checkpoint.id, "completed");

    expect(updated?.status).toBe("completed");
  });

  it("rejects an invalid status via the CHECK constraint", () => {
    const db = freshDb();
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "ar");

    expect(() => setStatus(db, checkpoint.id, "bogus" as never)).toThrowError(
      /CHECK constraint failed/,
    );
  });
});
