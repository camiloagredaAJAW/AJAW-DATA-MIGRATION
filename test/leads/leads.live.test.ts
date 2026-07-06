import "dotenv/config";
import { describe, expect, it } from "vitest";
import { fetchCatalog, fetchCompaniesPage } from "../../src/leads/leadsClient.js";
import type { LeadsClientConfig } from "../../src/leads/leadsClient.js";

/**
 * Live integration tier (design's testing-strategy `--live` row) — exercises
 * the real Leads DB `/dbs` catalog endpoint and one real paginated
 * `/companies` page fetch. Skipped by default; `npx vitest run` (CI) never
 * runs this file.
 *
 * To opt in with real dev credentials:
 *   1. Populate `.env` with LEADS_DB_BASE_URL / LEADS_DB_QP_KEY_VALUE (and
 *      optionally LEADS_DB_ALL / LEADS_DB_EXPORT if the paths differ from
 *      the defaults `dbs` / `companies`).
 *   2. Run: RUN_LIVE_AXELOR=1 npx vitest run test/leads/leads.live.test.ts
 *
 * Reuses the same RUN_LIVE_AXELOR gate as the Axelor live tier rather than a
 * separate flag — both tiers are only meaningful together as an end-to-end
 * smoke test against real dev infrastructure.
 */
describe.skipIf(!process.env.RUN_LIVE_AXELOR)("Leads DB live integration", () => {
  function leadsConfigFromEnv(): LeadsClientConfig {
    const baseUrl = process.env.LEADS_DB_BASE_URL;
    const keyValue = process.env.LEADS_DB_QP_KEY_VALUE;
    if (!baseUrl || !keyValue) {
      throw new Error(
        "LEADS_DB_BASE_URL and LEADS_DB_QP_KEY_VALUE must be set in .env to run this live tier",
      );
    }
    return {
      baseUrl,
      dbsPath: process.env.LEADS_DB_ALL ?? "dbs",
      companiesPath: process.env.LEADS_DB_EXPORT ?? "companies",
      keyValue,
    };
  }

  it("fetches the real catalog and one real page of companies for its first country", async () => {
    const config = leadsConfigFromEnv();
    const catalog = await fetchCatalog(config);
    expect(catalog.length).toBeGreaterThan(0);

    const [firstCountry] = catalog;
    const page = await fetchCompaniesPage(config, firstCountry!.sourceDb, 5, 0);
    expect(Array.isArray(page)).toBe(true);
  });
});
