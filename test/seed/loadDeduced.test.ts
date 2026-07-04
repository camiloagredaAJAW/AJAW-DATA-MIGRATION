import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { loadDeducedSeed, parseDeducedSeedRows } from "../../src/seed/loadDeduced.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");
const seedJsonPath = path.join(
  process.cwd(),
  "references",
  "leads-mapping",
  "field-mappings.deduced.json",
);

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function countRows(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
  ).count;
}

describe("parseDeducedSeedRows", () => {
  it("excludes the cr/progress pair even if present in the source JSON", () => {
    const json = JSON.stringify([
      { source_db: "cr", source_table: "progress", source_column: "cursor", destination_domain: "AiSearchResults" },
      { source_db: "cr", source_table: "companies", source_column: "legal_name", destination_domain: "AiSearchResults", destination_field: "title", confidence: "high" },
    ]);

    const rows = parseDeducedSeedRows(json);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_table).toBe("companies");
  });
});

describe("loadDeducedSeed", () => {
  it("loads all 832 committed seed rows into an empty database, none of them cr/progress", () => {
    const db = freshDb();

    const result = loadDeducedSeed(db, seedJsonPath);

    expect(result.totalRows).toBe(832);
    expect(countRows(db)).toBe(832);

    const progressRow = db
      .prepare(`SELECT 1 FROM field_mappings WHERE source_db = 'cr' AND source_table = 'progress'`)
      .get();
    expect(progressRow).toBeUndefined();
  });

  it("converts the JSON's 'unmapped' confidence sentinel to a nullable confidence (schema only allows high/medium/low)", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    const row = db
      .prepare(
        `SELECT confidence, destination_field FROM field_mappings
         WHERE source_db = 'ar_sipro' AND source_table = 'sipro' AND source_column = 'phone_valid'`,
      )
      .get() as { confidence: string | null; destination_field: string | null } | undefined;

    expect(row?.destination_field).toBeNull();
    expect(row?.confidence).toBeNull();
  });

  it("derives additional_info_key for preserved tax identifiers", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    const row = db
      .prepare(
        `SELECT additional_info_key FROM field_mappings
         WHERE source_db = 'brazil_cnpj' AND source_table = 'companies' AND source_column = 'cnpj'`,
      )
      .get() as { additional_info_key: string | null } | undefined;

    expect(row?.additional_info_key).toBe("sourceTaxId");
  });

  it("is idempotent: rerunning against an already-seeded database does not duplicate rows", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    const second = loadDeducedSeed(db, seedJsonPath);

    expect(second.totalRows).toBe(832);
    expect(countRows(db)).toBe(832);
  });

  it("never overwrites a row an admin has edited since the last seed/bootstrap run", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    db.prepare(
      `UPDATE field_mappings SET destination_field = 'title', origin = 'admin'
       WHERE source_db = 'ar' AND source_table = 'ar_extra' AND source_column = 'cuit'`,
    ).run();

    loadDeducedSeed(db, seedJsonPath);

    const row = db
      .prepare(
        `SELECT destination_field, origin FROM field_mappings
         WHERE source_db = 'ar' AND source_table = 'ar_extra' AND source_column = 'cuit'`,
      )
      .get() as { destination_field: string; origin: string };

    expect(row.origin).toBe("admin");
    expect(row.destination_field).toBe("title");
  });
});
