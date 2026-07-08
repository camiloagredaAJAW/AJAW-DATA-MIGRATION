import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { listSourceCatalog } from "../../src/db/catalogRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function insertSourceCatalogRow(
  db: Database.Database,
  row: {
    sourceDb: string;
    sourceTable: string;
    countryCode?: string | null;
    lastSampledAt?: string | null;
    sampledRowCount?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO source_catalog
       (source_db, source_table, country_code, last_sampled_at, sampled_row_count)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.sourceDb,
    row.sourceTable,
    row.countryCode ?? null,
    row.lastSampledAt ?? null,
    row.sampledRowCount ?? null,
  );
}

describe("listSourceCatalog", () => {
  it("returns an empty array when the table has no rows", () => {
    const db = freshDb();

    expect(listSourceCatalog(db)).toEqual([]);
  });

  it("returns rows ordered by source_db", () => {
    const db = freshDb();
    insertSourceCatalogRow(db, { sourceDb: "cl", sourceTable: "companies" });
    insertSourceCatalogRow(db, { sourceDb: "ar", sourceTable: "companies" });
    insertSourceCatalogRow(db, { sourceDb: "mx", sourceTable: "companies" });

    const rows = listSourceCatalog(db);

    expect(rows.map((row) => row.sourceDb)).toEqual(["ar", "cl", "mx"]);
  });

  it("maps nullable fields (country_code/last_sampled_at/sampled_row_count) to null when unset", () => {
    const db = freshDb();
    insertSourceCatalogRow(db, { sourceDb: "ar", sourceTable: "companies" });

    const [row] = listSourceCatalog(db);

    expect(row?.countryCode).toBeNull();
    expect(row?.lastSampledAt).toBeNull();
    expect(row?.sampledRowCount).toBeNull();
  });

  it("returns populated values when the row has been sampled", () => {
    const db = freshDb();
    insertSourceCatalogRow(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      countryCode: "ar",
      lastSampledAt: "2026-07-08T14:30:05.000Z",
      sampledRowCount: 42,
    });

    const [row] = listSourceCatalog(db);

    expect(row?.sourceDb).toBe("ar");
    expect(row?.sourceTable).toBe("companies");
    expect(row?.countryCode).toBe("ar");
    expect(row?.lastSampledAt).toBe("2026-07-08T14:30:05.000Z");
    expect(row?.sampledRowCount).toBe(42);
  });
});
