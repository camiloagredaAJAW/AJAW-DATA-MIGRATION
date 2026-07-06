import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun } from "../../src/db/runsRepo.js";
import { recordError } from "../../src/db/importErrorRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

describe("recordError", () => {
  it("inserts an import_errors row with the reason, country, offset, and identifier", () => {
    const db = freshDb();
    const run = createRun(db);

    const error = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 40,
      recordIdentifier: "row-3",
      errorReason: "Axelor rejected: missing required field",
    });

    expect(error.id).toBeGreaterThan(0);
    expect(error.runId).toBe(run.id);
    expect(error.countryCode).toBe("ar");
    expect(error.recordOffset).toBe(40);
    expect(error.recordIdentifier).toBe("row-3");
    expect(error.errorReason).toBe("Axelor rejected: missing required field");
    expect(error.resolved).toBe(false);

    const row = db.prepare(`SELECT * FROM import_errors WHERE id = ?`).get(error.id) as
      | Record<string, unknown>
      | undefined;
    expect(row?.error_reason).toBe("Axelor rejected: missing required field");
    expect(row?.resolved).toBe(0);
  });

  it("does not store any raw record payload data — only reason/country/offset/identifier/timestamp", () => {
    const db = freshDb();
    const run = createRun(db);

    const error = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: null,
      recordIdentifier: null,
      errorReason: "country page fetch failed: HTTP 500",
    });

    const row = db.prepare(`SELECT * FROM import_errors WHERE id = ?`).get(error.id) as Record<
      string,
      unknown
    >;
    expect(Object.keys(row).sort()).toEqual(
      [
        "country_code",
        "created_at",
        "error_reason",
        "id",
        "record_identifier",
        "record_offset",
        "resolved",
        "run_id",
      ].sort(),
    );
    expect(row.record_offset).toBeNull();
    expect(row.record_identifier).toBeNull();
  });

  it("enforces the import_errors.run_id foreign key", () => {
    const db = freshDb();

    expect(() =>
      recordError(db, {
        runId: 999999,
        countryCode: "ar",
        recordOffset: null,
        recordIdentifier: null,
        errorReason: "boom",
      }),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });
});
