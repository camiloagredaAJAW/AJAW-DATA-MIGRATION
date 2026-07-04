import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrate, runRefreshCatalog, runSample, runSeed } from "../../../src/cli/bootstrap.js";
import { buildServer } from "../../../src/api/server.js";
import type { AuthConfig } from "../../../src/api/auth/authGuard.js";
import type { LeadsClientConfig } from "../../../src/leads/leadsClient.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");
const seedJsonPath = path.join(
  process.cwd(),
  "references",
  "leads-mapping",
  "field-mappings.deduced.json",
);

const authConfig: AuthConfig = {
  username: "admin",
  password: "s3cret",
  internalApiKey: "internal-key-123",
};

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function validHeaders(): Record<string, string> {
  return {
    authorization: basicAuthHeader(authConfig.username, authConfig.password),
    "x-internal-api-key": authConfig.internalApiKey,
  };
}

function fakeLeadsConfig(
  databases: Record<string, string[]>,
  tableRows: Record<string, Record<string, unknown>[]>,
): LeadsClientConfig {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/dbs")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ countries: {}, databases }),
        text: async () => JSON.stringify({ countries: {}, databases }),
      };
    }

    const dbMatch = /db=([^&]+)/.exec(url);
    const tableMatch = /table=([^&]+)/.exec(url);
    const key = `${dbMatch?.[1]}/${tableMatch?.[1]}`;
    const rows = tableRows[key] ?? [];
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
    exportPath: "export",
    keyValue: "ajaw_live_2026",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

describe("authenticated CRUD update survives a later bootstrap CLI rerun", () => {
  it("keeps the API-set value after runSample re-samples the same column", async () => {
    const db = new Database(":memory:");
    runMigrate(db, migrationsDir);
    runSeed(db, seedJsonPath);

    const server = buildServer({ db, authConfig });
    const row = db
      .prepare(
        `SELECT id FROM field_mappings WHERE source_db = 'ar' AND source_table = 'ar_extra' AND source_column = 'cuit'`,
      )
      .get() as { id: number };

    const updateResponse = await server.inject({
      method: "PUT",
      url: `/api/field-mappings/${row.id}`,
      headers: validHeaders(),
      payload: { destinationField: "title" },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().data.origin).toBe("admin");

    const leadsConfig = fakeLeadsConfig(
      { ar: ["ar_extra"] },
      { "ar/ar_extra": [{ cuit: "20-12345678-9", tipo: "SA" }] },
    );
    await runRefreshCatalog(db, leadsConfig);
    await runSample(db, leadsConfig, { sourceDb: "ar", sourceTable: "ar_extra" });

    const persisted = db
      .prepare(`SELECT destination_field, origin FROM field_mappings WHERE id = ?`)
      .get(row.id) as { destination_field: string; origin: string };
    expect(persisted.destination_field).toBe("title");
    expect(persisted.origin).toBe("admin");
  });
});
