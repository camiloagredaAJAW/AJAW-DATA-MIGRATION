import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { runRefreshCatalog } from "../../src/cli/bootstrap.js";
import type { LeadsClientConfig } from "../../src/leads/leadsClient.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function fakeLeadsConfig(databases: Record<string, string[]>): LeadsClientConfig {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ countries: {}, databases }),
    text: async () => JSON.stringify({ countries: {}, databases }),
  });
  return {
    baseUrl: "http://leads.example.test",
    dbsPath: "dbs",
    exportPath: "export",
    keyValue: "ajaw_live_2026",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

describe("runRefreshCatalog", () => {
  it("records every source_db/source_table pair from /dbs with a fresh timestamp", async () => {
    const db = freshDb();
    const leadsConfig = fakeLeadsConfig({ ar: ["companies"], ar_sipro: ["sipro"] });

    const result = await runRefreshCatalog(db, leadsConfig);

    expect(result.totalCatalogEntries).toBe(2);
    const rows = db
      .prepare(`SELECT source_db, source_table, last_sampled_at FROM source_catalog ORDER BY source_db`)
      .all() as { source_db: string; source_table: string; last_sampled_at: string }[];
    expect(rows.map((r) => `${r.source_db}/${r.source_table}`)).toEqual([
      "ar/companies",
      "ar_sipro/sipro",
    ]);
    expect(rows.every((r) => typeof r.last_sampled_at === "string" && r.last_sampled_at.length > 0)).toBe(
      true,
    );
  });

  it("reports a source_db/source_table pair not previously recorded as new", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO source_catalog (source_db, source_table, last_sampled_at) VALUES ('ar', 'companies', '2020-01-01T00:00:00.000Z')`,
    ).run();

    const leadsConfig = fakeLeadsConfig({ ar: ["companies"], brazil_cnpj: ["contacts"] });
    const result = await runRefreshCatalog(db, leadsConfig);

    expect(result.newPairs).toEqual([{ sourceDb: "brazil_cnpj", sourceTable: "contacts" }]);
  });

  it("refreshes the timestamp of an already-known pair without duplicating it", async () => {
    const db = freshDb();
    const leadsConfig = fakeLeadsConfig({ ar: ["companies"] });

    await runRefreshCatalog(db, leadsConfig);
    await runRefreshCatalog(db, leadsConfig);

    const countRow = db.prepare(`SELECT COUNT(*) as count FROM source_catalog`).get() as {
      count: number;
    };
    expect(countRow.count).toBe(1);
  });
});
