import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { incrementSavedCount, getSavedCountsByDay } from "../../src/db/dailySaveStatsRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

describe("incrementSavedCount", () => {
  it("creates a row with count 1 on the first increment for a new day", () => {
    const db = freshDb();

    incrementSavedCount(db, "2026-07-08");

    const row = db.prepare(`SELECT * FROM daily_save_stats WHERE day = ?`).get("2026-07-08") as {
      day: string;
      saved_count: number;
    };
    expect(row.saved_count).toBe(1);
  });

  it("increments the same day's count on a second call", () => {
    const db = freshDb();

    incrementSavedCount(db, "2026-07-08");
    incrementSavedCount(db, "2026-07-08");

    const row = db.prepare(`SELECT * FROM daily_save_stats WHERE day = ?`).get("2026-07-08") as {
      saved_count: number;
    };
    expect(row.saved_count).toBe(2);
  });

  it("keeps increments on different days in separate rows", () => {
    const db = freshDb();

    incrementSavedCount(db, "2026-07-08");
    incrementSavedCount(db, "2026-07-09");
    incrementSavedCount(db, "2026-07-09");

    const rows = db.prepare(`SELECT day, saved_count FROM daily_save_stats ORDER BY day`).all() as {
      day: string;
      saved_count: number;
    }[];
    expect(rows).toEqual([
      { day: "2026-07-08", saved_count: 1 },
      { day: "2026-07-09", saved_count: 2 },
    ]);
  });
});

describe("getSavedCountsByDay", () => {
  it("returns an empty array for an empty table", () => {
    const db = freshDb();

    expect(getSavedCountsByDay(db)).toEqual([]);
  });

  it("returns every day's count in ascending order", () => {
    const db = freshDb();
    incrementSavedCount(db, "2026-07-09");
    incrementSavedCount(db, "2026-07-08");
    incrementSavedCount(db, "2026-07-08");

    const rows = getSavedCountsByDay(db);

    expect(rows).toEqual([
      { day: "2026-07-08", count: 2 },
      { day: "2026-07-09", count: 1 },
    ]);
  });

  it("respects sinceDay, excluding earlier days", () => {
    const db = freshDb();
    incrementSavedCount(db, "2026-07-07");
    incrementSavedCount(db, "2026-07-08");
    incrementSavedCount(db, "2026-07-09");

    const rows = getSavedCountsByDay(db, "2026-07-08");

    expect(rows).toEqual([
      { day: "2026-07-08", count: 1 },
      { day: "2026-07-09", count: 1 },
    ]);
  });
});
