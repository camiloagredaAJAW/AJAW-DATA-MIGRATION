import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { upsertFieldMapping } from "../../src/repos/mappingRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function readRow(db: Database.Database, sourceColumn: string) {
  return db
    .prepare(
      `SELECT * FROM field_mappings WHERE source_db = ? AND source_table = ? AND source_column = ?`,
    )
    .get("ar", "companies", sourceColumn) as Record<string, unknown> | undefined;
}

describe("upsertFieldMapping", () => {
  it("inserts a brand-new row and reports it as applied", () => {
    const db = freshDb();

    const result = upsertFieldMapping(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      sourceColumn: "legal_name",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "bootstrap",
    });

    expect(result.applied).toBe(true);
    const row = readRow(db, "legal_name");
    expect(row?.destination_field).toBe("title");
    expect(row?.origin).toBe("bootstrap");
  });

  it("updates an existing non-admin row on rerun", () => {
    const db = freshDb();
    upsertFieldMapping(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      sourceColumn: "legal_name",
      destinationDomain: "AiSearchResults",
      destinationField: null,
      additionalInfoKey: null,
      confidence: "low",
      note: null,
      origin: "bootstrap",
    });

    const result = upsertFieldMapping(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      sourceColumn: "legal_name",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "bootstrap",
    });

    expect(result.applied).toBe(true);
    const row = readRow(db, "legal_name");
    expect(row?.destination_field).toBe("title");
    expect(row?.confidence).toBe("high");
  });

  it("skips a row owned by an admin edit and reports it as not applied", () => {
    const db = freshDb();
    upsertFieldMapping(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      sourceColumn: "legal_name",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "admin",
    });

    const result = upsertFieldMapping(db, {
      sourceDb: "ar",
      sourceTable: "companies",
      sourceColumn: "legal_name",
      destinationDomain: "AiSearchResults",
      destinationField: "additionalInfo",
      additionalInfoKey: null,
      confidence: "low",
      note: null,
      origin: "bootstrap",
    });

    expect(result.applied).toBe(false);
    const row = readRow(db, "legal_name");
    expect(row?.destination_field).toBe("title");
    expect(row?.origin).toBe("admin");
  });
});
