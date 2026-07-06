import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate.js";
import { buildMigrationDeps, runMigrationCli } from "../../src/cli/migrate.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  return db;
}

function seedCatalog(db: Database.Database, countryCodes: string[]): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO source_catalog (source_db, source_table, last_sampled_at) VALUES (?, 'companies', ?)`,
  );
  for (const code of countryCodes) {
    insert.run(code, now);
  }
}

function fullEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    AXELOR_BASE_URL: "http://axelor.example.test",
    AXELOR_USERNAME: "admin",
    AXELOR_PASSWORD: "secret",
    AJAW_NAMESPACE: "com.ajaw",
    MODEL_NAME_COMPANIES: "AiSearchResults",
    LEADS_DB_PAGE_LIMIT: "100",
    LEADS_DB_BASE_URL: "http://leads.example.test",
    LEADS_DB_QP_KEY_VALUE: "ajaw_live_2026",
    ...overrides,
  };
}

function emptyPageFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "",
  }) as unknown as typeof fetch;
}

describe("buildMigrationDeps", () => {
  it("wires axelorConfig, leadsConfig, and pageLimit from the given env record", () => {
    const db = freshDb();

    const deps = buildMigrationDeps(db, {
      env: fullEnv(),
      leadsFetchImpl: emptyPageFetch(),
      axelorFetchImpl: emptyPageFetch(),
    });

    expect(deps.axelorConfig).toEqual({
      baseUrl: "http://axelor.example.test",
      username: "admin",
      password: "secret",
      namespace: "com.ajaw",
      modelNameCompanies: "AiSearchResults",
    });
    expect(deps.pageLimit).toBe(100);
    expect(deps.leadsConfig.baseUrl).toBe("http://leads.example.test");
    expect(typeof deps.session.getSession).toBe("function");
  });

  it("throws when LEADS_DB_BASE_URL is missing", () => {
    const db = freshDb();

    expect(() =>
      buildMigrationDeps(db, { env: fullEnv({ LEADS_DB_BASE_URL: undefined }) }),
    ).toThrow(/LEADS_DB_BASE_URL/);
  });
});

describe("runMigrationCli", () => {
  it("runs a migration for every catalog country using env-derived config", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR", "BO"]);

    const summary = await runMigrationCli(db, {
      env: fullEnv(),
      leadsFetchImpl: emptyPageFetch(),
      axelorFetchImpl: emptyPageFetch(),
    });

    expect(summary.countries.map((c) => c.countryCode).sort()).toEqual(["AR", "BO"]);
    expect(summary.countries.every((c) => c.status === "completed")).toBe(true);
  });

  it("restricts the run to explicitly provided countries", async () => {
    const db = freshDb();
    seedCatalog(db, ["AR", "BO"]);

    const summary = await runMigrationCli(db, {
      env: fullEnv(),
      leadsFetchImpl: emptyPageFetch(),
      axelorFetchImpl: emptyPageFetch(),
      countries: ["BO"],
    });

    expect(summary.countries.map((c) => c.countryCode)).toEqual(["BO"]);
  });
});
