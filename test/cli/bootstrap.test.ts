import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import {
  runFullReset,
  runMigrate,
  runRefreshCatalog,
  runSample,
  runSeed,
} from "../../src/cli/bootstrap.js";
import type { LeadsClientConfig } from "../../src/leads/leadsClient.js";
import { createRun } from "../../src/db/runsRepo.js";
import { upsertCheckpoint } from "../../src/db/checkpointRepo.js";
import { recordError } from "../../src/db/importErrorRepo.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");
const seedJsonPath = path.join(
  process.cwd(),
  "references",
  "leads-mapping",
  "field-mappings.deduced.json",
);

function bootstrappedDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrate(db, migrationsDir);
  return db;
}

function fakeLeadsConfig(
  countries: Record<string, unknown>,
  countryRows: Record<string, Record<string, unknown>[]>,
): LeadsClientConfig {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/dbs")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ countries, databases: {} }),
        text: async () => JSON.stringify({ countries, databases: {} }),
      };
    }

    const countryMatch = /country=([^&]+)/.exec(url);
    const code = countryMatch?.[1] ?? "";
    const rows = countryRows[code] ?? [];
    const jsonl = rows.map((row) => JSON.stringify(row)).join("\n");
    return {
      ok: true,
      status: 200,
      json: async () => rows,
      text: async () => jsonl,
    };
  });

  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    companiesPath: "companies",
    keyValue: "ajaw_live_2026",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

describe("bootstrap CLI: migrate + seed", () => {
  it("loads exactly the committed 163 seed rows on a fresh database", () => {
    const db = bootstrappedDb();

    const result = runSeed(db, seedJsonPath);

    expect(result.totalRows).toBe(163);
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as {
      count: number;
    };
    expect(countRow.count).toBe(163);
  });
});

describe("bootstrap CLI: full reset", () => {
  it("wipes every operational table and reseeds field_mappings + source_catalog in one step", async () => {
    const db = bootstrappedDb();
    runSeed(db, seedJsonPath);
    const run = createRun(db);
    upsertCheckpoint(db, run.id, "AR");
    recordError(db, {
      runId: run.id,
      countryCode: "AR",
      recordOffset: 1,
      recordIdentifier: "ACME",
      errorReason: "boom",
    });
    db.prepare(
      `INSERT INTO source_catalog (source_db, source_table, last_sampled_at)
       VALUES ('ZZ', 'companies', '2020-01-01T00:00:00.000Z')`,
    ).run();

    const leadsConfig = fakeLeadsConfig({ AR: {}, CO: {} }, {});

    const result = await runFullReset(db, leadsConfig);

    expect(result.seed.totalRows).toBe(163);
    expect(result.catalog.totalCatalogEntries).toBe(2);

    const runsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_runs`).get() as { count: number }
    ).count;
    const checkpointsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_checkpoints`).get() as { count: number }
    ).count;
    const errorsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM import_errors`).get() as { count: number }
    ).count;
    expect(runsCount).toBe(0);
    expect(checkpointsCount).toBe(0);
    expect(errorsCount).toBe(0);

    const mappingsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
    ).count;
    expect(mappingsCount).toBe(163);

    const catalogRows = db.prepare(`SELECT source_db FROM source_catalog ORDER BY source_db`).all();
    expect(catalogRows).toEqual([{ source_db: "AR" }, { source_db: "CO" }]);
  });

  it("wraps a post-wipe reseed failure in a single self-describing Error with manual-recovery instructions", async () => {
    const db = bootstrappedDb();
    runSeed(db, seedJsonPath);

    const failingFetchImpl = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const leadsConfig: LeadsClientConfig = {
      baseUrl: "http://leads.example.test",
      dbsPath: "dbs",
      companiesPath: "companies",
      keyValue: "ajaw_live_2026",
      fetchImpl: failingFetchImpl as unknown as typeof fetch,
    };

    await expect(runFullReset(db, leadsConfig)).rejects.toThrow(
      /Reset wiped all tables successfully, but re-seeding failed: network unreachable.*run 'npm run seed' and 'npm run refresh'/s,
    );

    // The wipe itself already committed before the reseed step failed:
    // migration_runs stays empty regardless of what happens afterward.
    const runsCount = (
      db.prepare(`SELECT COUNT(*) as count FROM migration_runs`).get() as { count: number }
    ).count;
    expect(runsCount).toBe(0);
  });
});

describe("bootstrap CLI: sample --refresh", () => {
  it("creates rows only for a newly-discovered catalog country, leaving other rows untouched", async () => {
    const db = bootstrappedDb();
    runSeed(db, seedJsonPath);

    const beforeCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
    ).count;

    const leadsConfig = fakeLeadsConfig(
      { ZZ: {} },
      {
        ZZ: [{ legal_name: "ACME", tax_id: "123" }],
      },
    );
    await runRefreshCatalog(db, leadsConfig);
    const result = await runSample(db, leadsConfig, {
      sourceDb: "ZZ",
      sourceTable: "companies",
    });

    expect(result.appliedMappings).toBe(2);
    const afterCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
    ).count;
    expect(afterCount).toBe(beforeCount + 2);

    const newRow = db
      .prepare(
        `SELECT destination_field FROM field_mappings
         WHERE source_db = 'ZZ' AND source_table = 'companies' AND source_column = 'legal_name'`,
      )
      .get() as { destination_field: string };
    expect(newRow.destination_field).toBe("title");
  });

  it("preserves an admin-edited row's value across a rerun of the sampling CLI", async () => {
    const db = bootstrappedDb();
    runSeed(db, seedJsonPath);

    db.prepare(
      `UPDATE field_mappings SET destination_field = 'title', origin = 'admin'
       WHERE source_db = 'CO' AND source_table = 'companies' AND source_column = 'matricula'`,
    ).run();

    const leadsConfig = fakeLeadsConfig(
      { CO: {} },
      {
        CO: [{ matricula: "12345-CO", tipo: "SA", fecha: "2020-01-01" }],
      },
    );
    await runRefreshCatalog(db, leadsConfig);
    await runSample(db, leadsConfig, { sourceDb: "CO", sourceTable: "companies" });

    const row = db
      .prepare(
        `SELECT destination_field, origin FROM field_mappings
         WHERE source_db = 'CO' AND source_table = 'companies' AND source_column = 'matricula'`,
      )
      .get() as { destination_field: string; origin: string };
    expect(row.origin).toBe("admin");
    expect(row.destination_field).toBe("title");
  });

  it("skips a 0-row country without deleting any existing rows for it", async () => {
    const db = bootstrappedDb();
    runSeed(db, seedJsonPath);
    const beforeCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
    ).count;

    const leadsConfig = fakeLeadsConfig({ CO: {} }, { CO: [] });
    await runRefreshCatalog(db, leadsConfig);
    const result = await runSample(db, leadsConfig, { sourceDb: "CO", sourceTable: "companies" });

    expect(result.appliedMappings).toBe(0);
    const afterCount = (
      db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get() as { count: number }
    ).count;
    expect(afterCount).toBe(beforeCount);
  });

  it("reports a failing country without aborting the rest of the run", async () => {
    const db = bootstrappedDb();
    runSeed(db, seedJsonPath);

    const leadsConfig = fakeLeadsConfig({ CO: {} }, {});
    (leadsConfig.fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ countries: { CO: {} }, databases: {} }),
        text: async () => JSON.stringify({ countries: { CO: {} }, databases: {} }),
      }),
    );
    await runRefreshCatalog(db, leadsConfig);

    (leadsConfig.fetchImpl as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("timeout"),
    );
    const result = await runSample(db, leadsConfig, { sourceDb: "CO", sourceTable: "companies" });

    expect(result.failedTables).toEqual([{ sourceDb: "CO", sourceTable: "companies", error: "timeout" }]);
  });
});
