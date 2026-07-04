import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import {
  adminUpdateFieldMapping,
  getFieldMappingById,
  listFieldMappings,
  upsertFieldMapping,
} from "../../src/repos/mappingRepo.js";

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

describe("listFieldMappings", () => {
  it("returns every row when no filter is given", () => {
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
      origin: "bootstrap",
    });
    upsertFieldMapping(db, {
      sourceDb: "cl",
      sourceTable: "companies",
      sourceColumn: "razon_social",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "bootstrap",
    });

    const rows = listFieldMappings(db);

    expect(rows).toHaveLength(2);
  });

  it("filters by sourceDb and sourceTable", () => {
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
      origin: "bootstrap",
    });
    upsertFieldMapping(db, {
      sourceDb: "cl",
      sourceTable: "companies",
      sourceColumn: "razon_social",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "bootstrap",
    });

    const rows = listFieldMappings(db, { sourceDb: "cl", sourceTable: "companies" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceColumn).toBe("razon_social");
  });
});

describe("getFieldMappingById", () => {
  it("returns the mapped row for an existing id", () => {
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
      origin: "bootstrap",
    });
    const id = (
      db.prepare(`SELECT id FROM field_mappings WHERE source_column = 'legal_name'`).get() as {
        id: number;
      }
    ).id;

    const row = getFieldMappingById(db, id);

    expect(row?.sourceColumn).toBe("legal_name");
    expect(row?.destinationField).toBe("title");
    expect(row?.origin).toBe("bootstrap");
  });

  it("returns null for a non-existent id", () => {
    const db = freshDb();

    const row = getFieldMappingById(db, 999999);

    expect(row).toBeNull();
  });
});

describe("adminUpdateFieldMapping", () => {
  it("updates destinationField and forces origin to admin", () => {
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
    const id = (
      db.prepare(`SELECT id FROM field_mappings WHERE source_column = 'legal_name'`).get() as {
        id: number;
      }
    ).id;

    const updated = adminUpdateFieldMapping(db, id, { destinationField: "title" });

    expect(updated?.destinationField).toBe("title");
    expect(updated?.origin).toBe("admin");
    const persisted = readRow(db, "legal_name");
    expect(persisted?.destination_field).toBe("title");
    expect(persisted?.origin).toBe("admin");
  });

  it("makes an admin update stick across a later bootstrap-origin upsert", () => {
    const db = freshDb();
    upsertFieldMapping(db, {
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
    const id = (
      db.prepare(`SELECT id FROM field_mappings WHERE source_column = 'legal_name'`).get() as {
        id: number;
      }
    ).id;
    adminUpdateFieldMapping(db, id, { destinationField: "title" });

    upsertFieldMapping(db, {
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

    const persisted = readRow(db, "legal_name");
    expect(persisted?.destination_field).toBe("title");
    expect(persisted?.origin).toBe("admin");
  });

  it("returns null for a non-existent id and changes nothing", () => {
    const db = freshDb();

    const updated = adminUpdateFieldMapping(db, 999999, { destinationField: "title" });

    expect(updated).toBeNull();
  });
});
