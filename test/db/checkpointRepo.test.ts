import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun } from "../../src/db/runsRepo.js";
import {
  advanceOffset,
  getByRunCountry,
  getMostRecentCheckpointForCountry,
  listByRun,
  listLatestCheckpointsPerCountry,
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

/** Backdates/forward-dates a checkpoint's updated_at, mirroring importErrorRepo.test.ts's setCreatedAt helper. */
function setUpdatedAt(db: Database.Database, id: number, isoString: string): void {
  db.prepare(`UPDATE migration_checkpoints SET updated_at = ? WHERE id = ?`).run(isoString, id);
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

  it("seeds last_offset and ai_search_id from the most recent checkpoint for the country when a DIFFERENT run creates a checkpoint for the first time", () => {
    const db = freshDb();
    const runA = createRun(db);
    const checkpointA = upsertCheckpoint(db, runA.id, "ar");
    advanceOffset(db, checkpointA.id, 500);
    setAiSearchId(db, checkpointA.id, 777);

    const runB = createRun(db);
    const checkpointB = upsertCheckpoint(db, runB.id, "ar");

    expect(checkpointB.runId).toBe(runB.id);
    expect(checkpointB.lastOffset).toBe(500);
    expect(checkpointB.aiSearchId).toBe(777);
  });

  it("still defaults to offset 0 / null ai_search_id when NO checkpoint exists yet for the country in any run", () => {
    const db = freshDb();
    const run = createRun(db);

    const checkpoint = upsertCheckpoint(db, run.id, "cl");

    expect(checkpoint.lastOffset).toBe(0);
    expect(checkpoint.aiSearchId).toBeNull();
  });
});

describe("getMostRecentCheckpointForCountry", () => {
  it("returns null when no checkpoint exists yet for the country in any run", () => {
    const db = freshDb();

    const found = getMostRecentCheckpointForCountry(db, "ar");

    expect(found).toBeNull();
  });

  it("returns the most recently updated checkpoint for the country across ALL runs", () => {
    const db = freshDb();
    const runA = createRun(db);
    const checkpointA = upsertCheckpoint(db, runA.id, "ar");
    advanceOffset(db, checkpointA.id, 500);

    const runB = createRun(db);
    const checkpointB = upsertCheckpoint(db, runB.id, "ar");
    advanceOffset(db, checkpointB.id, 750);

    const found = getMostRecentCheckpointForCountry(db, "ar");

    expect(found?.runId).toBe(runB.id);
    expect(found?.lastOffset).toBe(750);
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

describe("listLatestCheckpointsPerCountry", () => {
  it("returns [] when there are no checkpoints at all", () => {
    const db = freshDb();

    const found = listLatestCheckpointsPerCountry(db);

    expect(found).toEqual([]);
  });

  it("returns the highest-id checkpoint per country when a country has checkpoints across multiple runs", () => {
    const db = freshDb();
    const runA = createRun(db);
    const checkpointA = upsertCheckpoint(db, runA.id, "ar");
    advanceOffset(db, checkpointA.id, 500);

    const runB = createRun(db);
    const checkpointB = upsertCheckpoint(db, runB.id, "ar");
    advanceOffset(db, checkpointB.id, 750);

    const found = listLatestCheckpointsPerCountry(db);

    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(checkpointB.id);
    expect(found[0]?.runId).toBe(runB.id);
    expect(found[0]?.lastOffset).toBe(750);
  });

  it("returns all countries that have ever had a checkpoint, ordered by country_code", () => {
    const db = freshDb();
    const run = createRun(db);
    upsertCheckpoint(db, run.id, "cl");
    upsertCheckpoint(db, run.id, "ar");
    upsertCheckpoint(db, run.id, "br");

    const found = listLatestCheckpointsPerCountry(db);

    expect(found.map((row) => row.countryCode)).toEqual(["ar", "br", "cl"]);
  });

  it("still shows a country with only one checkpoint ever", () => {
    const db = freshDb();
    const run = createRun(db);
    const checkpoint = upsertCheckpoint(db, run.id, "pe");

    const found = listLatestCheckpointsPerCountry(db);

    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(checkpoint.id);
    expect(found[0]?.countryCode).toBe("pe");
  });

  it("picks the row with the later updated_at over the row with the higher id, matching getMostRecentCheckpointForCountry's tie-break", () => {
    const db = freshDb();
    const runA = createRun(db);
    const checkpointA = upsertCheckpoint(db, runA.id, "ar");

    const runB = createRun(db);
    const checkpointB = upsertCheckpoint(db, runB.id, "ar");

    // checkpointB has the higher id (created second), but checkpointA is
    // backdated to a LATER updated_at than checkpointB — e.g. a status
    // update touching the older run's checkpoint after the newer run's
    // checkpoint row was created but before it was itself touched.
    expect(checkpointB.id).toBeGreaterThan(checkpointA.id);
    setUpdatedAt(db, checkpointB.id, "2026-01-01T00:00:00.000Z");
    setUpdatedAt(db, checkpointA.id, "2026-01-02T00:00:00.000Z");

    const found = listLatestCheckpointsPerCountry(db);

    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(checkpointA.id);
    expect(getMostRecentCheckpointForCountry(db, "ar")?.id).toBe(checkpointA.id);
  });

  it("shows each country's latest checkpoint alongside other untouched countries' latest checkpoints from an older run", () => {
    const db = freshDb();
    const runA = createRun(db);
    upsertCheckpoint(db, runA.id, "ar");
    upsertCheckpoint(db, runA.id, "cl");

    const runB = createRun(db);
    const retriedCheckpoint = upsertCheckpoint(db, runB.id, "ar");
    advanceOffset(db, retriedCheckpoint.id, 999);

    const found = listLatestCheckpointsPerCountry(db);

    expect(found).toHaveLength(2);
    const ar = found.find((row) => row.countryCode === "ar");
    const cl = found.find((row) => row.countryCode === "cl");
    expect(ar?.runId).toBe(runB.id);
    expect(ar?.lastOffset).toBe(999);
    expect(cl?.runId).toBe(runA.id);
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
