import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { createRun } from "../../src/db/runsRepo.js";
import {
  recordError,
  listImportErrors,
  countImportErrors,
  getImportErrorById,
  markResolved,
  updateErrorReason,
} from "../../src/db/importErrorRepo.js";

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

describe("getImportErrorById", () => {
  it("returns the matching row", () => {
    const db = freshDb();
    const run = createRun(db);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 10,
      recordIdentifier: "row-1",
      errorReason: "boom",
    });

    const found = getImportErrorById(db, error.id);

    expect(found?.id).toBe(error.id);
    expect(found?.errorReason).toBe("boom");
  });

  it("returns null for a non-existent id", () => {
    const db = freshDb();

    expect(getImportErrorById(db, 999999)).toBeNull();
  });
});

describe("listImportErrors", () => {
  it("returns all rows when no filter is given", () => {
    const db = freshDb();
    const run = createRun(db);
    recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-ar",
    });
    recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-cl",
    });

    const errors = listImportErrors(db, {});

    expect(errors).toHaveLength(2);
  });

  it("filters by runId", () => {
    const db = freshDb();
    const run1 = createRun(db);
    const run2 = createRun(db);
    recordError(db, {
      runId: run1.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-run1",
    });
    recordError(db, {
      runId: run2.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-run2",
    });

    const errors = listImportErrors(db, { runId: run1.id });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.errorReason).toBe("boom-run1");
  });

  it("filters by countryCode", () => {
    const db = freshDb();
    const run = createRun(db);
    recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-ar",
    });
    recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-cl",
    });

    const errors = listImportErrors(db, { countryCode: "cl" });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.countryCode).toBe("cl");
  });

  it("filters by resolved", () => {
    const db = freshDb();
    const run = createRun(db);
    const resolvedError = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-resolved",
    });
    recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-unresolved",
    });
    markResolved(db, resolvedError.id);

    const unresolved = listImportErrors(db, { resolved: false });
    const resolved = listImportErrors(db, { resolved: true });

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.errorReason).toBe("boom-unresolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.errorReason).toBe("boom-resolved");
  });

  it("respects limit/offset, returning the requested page in id order", () => {
    const db = freshDb();
    const run = createRun(db);
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(
        recordError(db, {
          runId: run.id,
          countryCode: "ar",
          recordOffset: i,
          recordIdentifier: null,
          errorReason: `boom-${i}`,
        }),
      );
    }

    const page = listImportErrors(db, { limit: 2, offset: 2 });

    expect(page).toHaveLength(2);
    expect(page.map((row) => row.id)).toEqual([seeded[2]?.id, seeded[3]?.id]);
  });

  it("accepts an offset with no limit (SQLite rejects a bare OFFSET with no LIMIT)", () => {
    const db = freshDb();
    const run = createRun(db);
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(
        recordError(db, {
          runId: run.id,
          countryCode: "ar",
          recordOffset: i,
          recordIdentifier: null,
          errorReason: `boom-${i}`,
        }),
      );
    }

    const page = listImportErrors(db, { offset: 3 });

    expect(page.map((row) => row.id)).toEqual([seeded[3]?.id, seeded[4]?.id]);
  });

  it("returns an empty array (not an error) when offset exceeds the total matching row count", () => {
    const db = freshDb();
    const run = createRun(db);
    for (let i = 0; i < 5; i++) {
      recordError(db, {
        runId: run.id,
        countryCode: "ar",
        recordOffset: i,
        recordIdentifier: null,
        errorReason: `boom-${i}`,
      });
    }

    const page = listImportErrors(db, { offset: 100 });

    expect(page).toEqual([]);
    // countImportErrors must keep reporting the real, non-zero total —
    // pagination metadata (e.g. `total` in the errors API response) must not
    // be affected by an out-of-range page request.
    expect(countImportErrors(db, {})).toBe(5);
  });

  it("returns everything when limit/offset are omitted (backward compat)", () => {
    const db = freshDb();
    const run = createRun(db);
    for (let i = 0; i < 5; i++) {
      recordError(db, {
        runId: run.id,
        countryCode: "ar",
        recordOffset: i,
        recordIdentifier: null,
        errorReason: `boom-${i}`,
      });
    }

    const rows = listImportErrors(db, {});

    expect(rows).toHaveLength(5);
  });
});

describe("countImportErrors", () => {
  it("counts all rows when no filter is given", () => {
    const db = freshDb();
    const run = createRun(db);
    recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-ar",
    });
    recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-cl",
    });

    expect(countImportErrors(db, {})).toBe(2);
  });

  it("matches the same filter semantics as listImportErrors (runId/countryCode/resolved)", () => {
    const db = freshDb();
    const run1 = createRun(db);
    const run2 = createRun(db);
    const resolvedError = recordError(db, {
      runId: run1.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-run1-ar",
    });
    recordError(db, {
      runId: run1.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-run1-cl",
    });
    recordError(db, {
      runId: run2.id,
      countryCode: "ar",
      recordOffset: 3,
      recordIdentifier: null,
      errorReason: "boom-run2-ar",
    });
    markResolved(db, resolvedError.id);

    expect(countImportErrors(db, { runId: run1.id })).toBe(2);
    expect(countImportErrors(db, { countryCode: "ar" })).toBe(2);
    expect(countImportErrors(db, { resolved: true })).toBe(1);
    expect(countImportErrors(db, { resolved: false })).toBe(2);
  });

  it("counts the FULL matching set even when a limit/offset would be used for the page", () => {
    const db = freshDb();
    const run = createRun(db);
    for (let i = 0; i < 5; i++) {
      recordError(db, {
        runId: run.id,
        countryCode: "ar",
        recordOffset: i,
        recordIdentifier: null,
        errorReason: `boom-${i}`,
      });
    }

    const page = listImportErrors(db, { runId: run.id, limit: 2, offset: 0 });
    const total = countImportErrors(db, { runId: run.id });

    expect(page).toHaveLength(2);
    expect(total).toBe(5);
  });
});

describe("markResolved", () => {
  it("sets resolved=true on the matching row", () => {
    const db = freshDb();
    const run = createRun(db);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom",
    });

    const updated = markResolved(db, error.id);

    expect(updated?.resolved).toBe(true);
    const row = db.prepare(`SELECT * FROM import_errors WHERE id = ?`).get(error.id) as {
      resolved: number;
    };
    expect(row.resolved).toBe(1);
  });

  it("returns null for a non-existent id", () => {
    const db = freshDb();

    expect(markResolved(db, 999999)).toBeNull();
  });
});

describe("updateErrorReason", () => {
  it("updates the error_reason on the matching row, leaving resolved unchanged", () => {
    const db = freshDb();
    const run = createRun(db);
    const error = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "original reason",
    });

    const updated = updateErrorReason(db, error.id, "retry failed: Axelor rejected again");

    expect(updated?.errorReason).toBe("retry failed: Axelor rejected again");
    expect(updated?.resolved).toBe(false);
  });

  it("returns null for a non-existent id", () => {
    const db = freshDb();

    expect(updateErrorReason(db, 999999, "whatever")).toBeNull();
  });
});
