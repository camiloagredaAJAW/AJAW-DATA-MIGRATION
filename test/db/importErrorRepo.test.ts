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
  getErrorAnalytics,
  getErrorCountsByDay,
} from "../../src/db/importErrorRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

/** Backdates a row's created_at so getErrorAnalytics tests can control day/hour bucketing deterministically. */
function setCreatedAt(db: Database.Database, id: number, isoString: string): void {
  db.prepare(`UPDATE import_errors SET created_at = ? WHERE id = ?`).run(isoString, id);
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

describe("getErrorAnalytics", () => {
  it("returns an empty array for an empty table", () => {
    const db = freshDb();

    expect(getErrorAnalytics(db)).toEqual([]);
  });

  it("returns a single 100% bucket when every row falls in the same day+hour", () => {
    const db = freshDb();
    const run = createRun(db);
    const first = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-1",
    });
    const second = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-2",
    });
    setCreatedAt(db, first.id, "2026-07-08T14:05:00.000Z");
    setCreatedAt(db, second.id, "2026-07-08T14:55:00.000Z");

    const buckets = getErrorAnalytics(db);

    expect(buckets).toEqual([{ day: "2026-07-08", hour: "14", count: 2, percentage: 100 }]);
  });

  it("buckets by UTC day+hour across multiple runs/countries/resolved states, ordered day DESC then hour DESC", () => {
    const db = freshDb();
    const run1 = createRun(db);
    const run2 = createRun(db);

    const a = recordError(db, {
      runId: run1.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-a",
    });
    const b = recordError(db, {
      runId: run2.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-b",
    });
    const c = recordError(db, {
      runId: run1.id,
      countryCode: "ar",
      recordOffset: 3,
      recordIdentifier: null,
      errorReason: "boom-c",
    });
    const d = recordError(db, {
      runId: run2.id,
      countryCode: "co",
      recordOffset: 4,
      recordIdentifier: null,
      errorReason: "boom-d",
    });
    // Same UTC day+hour as `a`, different run/country/resolved — must still
    // count together since this endpoint is an unfiltered whole-table view.
    setCreatedAt(db, a.id, "2026-07-08T09:10:00.000Z");
    markResolved(db, a.id);
    setCreatedAt(db, b.id, "2026-07-08T09:40:00.000Z");
    setCreatedAt(db, c.id, "2026-07-08T14:00:00.000Z");
    setCreatedAt(db, d.id, "2026-07-09T00:00:00.000Z");

    const buckets = getErrorAnalytics(db);

    expect(buckets).toEqual([
      { day: "2026-07-09", hour: "00", count: 1, percentage: 25 },
      { day: "2026-07-08", hour: "14", count: 1, percentage: 25 },
      { day: "2026-07-08", hour: "09", count: 2, percentage: 50 },
    ]);
    const totalPercentage = buckets.reduce((sum, bucket) => sum + bucket.percentage, 0);
    expect(totalPercentage).toBeCloseTo(100, 5);
  });

  it("filters to the requested day, grouping by hour only and ordering hour DESC", () => {
    const db = freshDb();
    const run = createRun(db);
    const a = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-a",
    });
    const b = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-b",
    });
    const c = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 3,
      recordIdentifier: null,
      errorReason: "boom-c",
    });
    setCreatedAt(db, a.id, "2026-07-08T09:10:00.000Z");
    setCreatedAt(db, b.id, "2026-07-08T09:40:00.000Z");
    setCreatedAt(db, c.id, "2026-07-08T14:00:00.000Z");

    const buckets = getErrorAnalytics(db, "2026-07-08");

    expect(buckets).toEqual([
      { day: "2026-07-08", hour: "14", count: 1, percentage: 33.3 },
      { day: "2026-07-08", hour: "09", count: 2, percentage: 66.7 },
    ]);
  });

  it("scopes percentage to the requested day's own total, decoupled from a different day's much larger total", () => {
    const db = freshDb();
    const run = createRun(db);
    const targetDay = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-target",
    });
    const otherDay1 = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-other-1",
    });
    const otherDay2 = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 3,
      recordIdentifier: null,
      errorReason: "boom-other-2",
    });
    const otherDay3 = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 4,
      recordIdentifier: null,
      errorReason: "boom-other-3",
    });
    setCreatedAt(db, targetDay.id, "2026-07-08T09:00:00.000Z");
    setCreatedAt(db, otherDay1.id, "2026-07-09T01:00:00.000Z");
    setCreatedAt(db, otherDay2.id, "2026-07-09T02:00:00.000Z");
    setCreatedAt(db, otherDay3.id, "2026-07-09T03:00:00.000Z");

    // If percentage were still computed against the whole table (4 rows),
    // this would read 25% instead of 100% — that's exactly the bug this
    // feature fixes.
    const buckets = getErrorAnalytics(db, "2026-07-08");

    expect(buckets).toEqual([{ day: "2026-07-08", hour: "09", count: 1, percentage: 100 }]);
  });

  it("returns an empty array for a day with zero errors, even when other days have errors", () => {
    const db = freshDb();
    const run = createRun(db);
    const other = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom",
    });
    setCreatedAt(db, other.id, "2026-07-08T09:00:00.000Z");

    expect(getErrorAnalytics(db, "2026-07-09")).toEqual([]);
  });

  it("returns an empty array for a day string that is shaped like YYYY-MM-DD but isn't a real calendar date, rather than throwing", () => {
    // The route layer only validates the shape (/^\d{4}-\d{2}-\d{2}$/), not
    // that it's a real date — strftime comparison just never matches, so a
    // garbage-but-shaped day degrades to an empty result, not an error.
    const db = freshDb();
    const run = createRun(db);
    const row = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom",
    });
    setCreatedAt(db, row.id, "2026-07-08T09:00:00.000Z");

    expect(getErrorAnalytics(db, "2026-13-99")).toEqual([]);
  });

  it("leaves whole-table semantics unchanged when called with no day argument", () => {
    const db = freshDb();
    const run = createRun(db);
    const first = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-1",
    });
    const second = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-2",
    });
    setCreatedAt(db, first.id, "2026-07-08T09:00:00.000Z");
    setCreatedAt(db, second.id, "2026-07-09T09:00:00.000Z");

    const buckets = getErrorAnalytics(db);

    expect(buckets).toEqual([
      { day: "2026-07-09", hour: "09", count: 1, percentage: 50 },
      { day: "2026-07-08", hour: "09", count: 1, percentage: 50 },
    ]);
  });
});

describe("getErrorCountsByDay", () => {
  it("returns an empty array for an empty table", () => {
    const db = freshDb();

    expect(getErrorCountsByDay(db)).toEqual([]);
  });

  it("groups by UTC day and returns counts in ascending day order", () => {
    const db = freshDb();
    const run = createRun(db);
    const first = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-1",
    });
    const second = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-2",
    });
    const third = recordError(db, {
      runId: run.id,
      countryCode: "cl",
      recordOffset: 3,
      recordIdentifier: null,
      errorReason: "boom-3",
    });
    setCreatedAt(db, first.id, "2026-07-08T09:10:00.000Z");
    setCreatedAt(db, second.id, "2026-07-08T14:00:00.000Z");
    setCreatedAt(db, third.id, "2026-07-09T00:00:00.000Z");

    const counts = getErrorCountsByDay(db);

    expect(counts).toEqual([
      { day: "2026-07-08", count: 2 },
      { day: "2026-07-09", count: 1 },
    ]);
  });

  it("respects sinceDay, excluding earlier days", () => {
    const db = freshDb();
    const run = createRun(db);
    const first = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 1,
      recordIdentifier: null,
      errorReason: "boom-1",
    });
    const second = recordError(db, {
      runId: run.id,
      countryCode: "ar",
      recordOffset: 2,
      recordIdentifier: null,
      errorReason: "boom-2",
    });
    setCreatedAt(db, first.id, "2026-07-07T09:10:00.000Z");
    setCreatedAt(db, second.id, "2026-07-08T09:10:00.000Z");

    const counts = getErrorCountsByDay(db, "2026-07-08");

    expect(counts).toEqual([{ day: "2026-07-08", count: 1 }]);
  });
});
