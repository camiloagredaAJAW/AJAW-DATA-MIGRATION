import { describe, expect, it } from "vitest";
import path from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { loadDeducedSeed, parseDeducedSeedRows, type DeducedSeedRow } from "../../src/seed/loadDeduced.js";

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
  it("parses every row from the JSON as-is (no source_db/source_table exclusion filter)", () => {
    const json = JSON.stringify([
      { source_db: "CO", source_table: "companies", source_column: "cursor", destination_domain: "AiSearchResults" },
      { source_db: "CO", source_table: "companies", source_column: "legal_name", destination_domain: "AiSearchResults", destination_field: "title", confidence: "high" },
    ]);

    const rows = parseDeducedSeedRows(json);

    expect(rows).toHaveLength(2);
  });
});

describe("loadDeducedSeed", () => {
  it("loads all 163 committed seed rows into an empty database", () => {
    const db = freshDb();

    const result = loadDeducedSeed(db, seedJsonPath);

    expect(result.totalRows).toBe(163);
    expect(countRows(db)).toBe(163);
  });

  it("converts the JSON's 'unmapped' confidence sentinel to a nullable confidence (schema only allows high/medium/low)", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    const row = db
      .prepare(
        `SELECT confidence, destination_field FROM field_mappings
         WHERE source_db = 'CO' AND source_table = 'companies' AND source_column = 'osm_match_conf'`,
      )
      .get() as { confidence: string | null; destination_field: string | null } | undefined;

    expect(row?.destination_field).toBeNull();
    expect(row?.confidence).toBeNull();
  });

  it("derives additional_info_key for preserved tax identifiers directly from the JSON's own field", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    const row = db
      .prepare(
        `SELECT additional_info_key FROM field_mappings
         WHERE source_db = 'BR' AND source_table = 'companies' AND source_column = 'cnpj'`,
      )
      .get() as { additional_info_key: string | null } | undefined;

    expect(row?.additional_info_key).toBe("sourceTaxId");
  });

  // Regression test: the CO `matricula` row was previously computed via a
  // static column-name map (which had no entry for "matricula"), producing
  // additional_info_key = null even though the seed JSON itself carries
  // additional_info_key = "sourceRegistrationNumber". This guards the fix:
  // the loader must read the value directly from the row's own JSON field.
  it("regression: CO matricula row's additional_info_key reads 'sourceRegistrationNumber' directly from the seed JSON", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    const row = db
      .prepare(
        `SELECT additional_info_key FROM field_mappings
         WHERE source_db = 'CO' AND source_table = 'companies' AND source_column = 'matricula'`,
      )
      .get() as { additional_info_key: string | null } | undefined;

    expect(row?.additional_info_key).toBe("sourceRegistrationNumber");
  });

  it("the JSON's own additional_info_key wins over anything a static column-name map would compute", () => {
    const db = freshDb();
    const json = JSON.stringify([
      {
        source_db: "ZZ",
        source_table: "companies",
        // "cuit" would resolve to "sourceTaxId" under the old static
        // TAX_ID_ADDITIONAL_INFO_KEYS map — the JSON's explicit value must
        // win instead.
        source_column: "cuit",
        destination_domain: "AiSearchResults",
        destination_field: "additionalInfo",
        confidence: "medium",
        additional_info_key: "customOverrideKey",
      } satisfies DeducedSeedRow,
    ]);
    const rows = parseDeducedSeedRows(json);
    expect(rows).toHaveLength(1);

    const jsonPath = path.join(process.cwd(), "test", "seed", "__fixture-override.json");
    writeFileSync(jsonPath, json, "utf-8");
    try {
      loadDeducedSeed(db, jsonPath);
    } finally {
      unlinkSync(jsonPath);
    }

    const row = db
      .prepare(
        `SELECT additional_info_key FROM field_mappings
         WHERE source_db = 'ZZ' AND source_table = 'companies' AND source_column = 'cuit'`,
      )
      .get() as { additional_info_key: string | null } | undefined;

    expect(row?.additional_info_key).toBe("customOverrideKey");
  });

  it("is idempotent: rerunning against an already-seeded database does not duplicate rows", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    const second = loadDeducedSeed(db, seedJsonPath);

    expect(second.totalRows).toBe(163);
    expect(countRows(db)).toBe(163);
  });

  it("never overwrites a row an admin has edited since the last seed/bootstrap run", () => {
    const db = freshDb();
    loadDeducedSeed(db, seedJsonPath);

    db.prepare(
      `UPDATE field_mappings SET destination_field = 'title', origin = 'admin'
       WHERE source_db = 'CO' AND source_table = 'companies' AND source_column = 'tax_id'`,
    ).run();

    loadDeducedSeed(db, seedJsonPath);

    const row = db
      .prepare(
        `SELECT destination_field, origin FROM field_mappings
         WHERE source_db = 'CO' AND source_table = 'companies' AND source_column = 'tax_id'`,
      )
      .get() as { destination_field: string; origin: string };

    expect(row.origin).toBe("admin");
    expect(row.destination_field).toBe("title");
  });
});
