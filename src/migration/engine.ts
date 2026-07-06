import type Database from "better-sqlite3";
import type { AxelorConfig } from "../config/env.js";
import type { LeadsClientConfig } from "../leads/leadsClient.js";
import { fetchCompaniesPage } from "../leads/leadsClient.js";
import type { AxelorSessionClient } from "../axelor/sessionClient.js";
import { createAiSearch, createAiSearchResults } from "../axelor/restClient.js";
import { sanitizeRecord } from "../sanitize/sanitize.js";
import { buildAiSearchResultsPayload } from "./payloadBuilder.js";
import { listFieldMappings } from "../repos/mappingRepo.js";
import { createRun, updateRunStatus } from "../db/runsRepo.js";
import {
  upsertCheckpoint,
  advanceOffset,
  setAiSearchId,
  setStatus,
  type MigrationCheckpointStatus,
} from "../db/checkpointRepo.js";
import { recordError } from "../db/importErrorRepo.js";

export interface MigrationEngineDeps {
  readonly db: Database.Database;
  readonly leadsConfig: LeadsClientConfig;
  readonly axelorConfig: AxelorConfig;
  /** Page size requested from the Leads DB (`LEADS_DB_PAGE_LIMIT`). */
  readonly pageLimit: number;
  readonly session: AxelorSessionClient;
  /** Injectable fetch implementation for Axelor REST calls. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Country codes to process. Defaults to every country registered in `source_catalog`. */
  readonly countries?: readonly string[];
  /** An existing `migration_runs` id to resume. A new run is created when omitted. */
  readonly runId?: number;
}

export interface CountryMigrationSummary {
  readonly countryCode: string;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly status: MigrationCheckpointStatus;
}

export interface MigrationSummary {
  readonly runId: number;
  readonly countries: readonly CountryMigrationSummary[];
}

const SOURCE_TABLE = "companies";

function getDefaultCountries(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT source_db FROM source_catalog ORDER BY source_db`)
    .all() as { source_db: string }[];
  return rows.map((row) => row.source_db);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort human-readable identifier for an import_errors row. Never the
 * raw record payload (per the migration-persistence spec) — just a single
 * recognizable field, when present, to help a human locate the failing row.
 */
function deriveRecordIdentifier(record: Record<string, unknown>): string | null {
  const candidate = record["legal_name"] ?? record["name"] ?? record["id"];
  return typeof candidate === "string" ? candidate : null;
}

interface CountryMigrationContext {
  readonly db: Database.Database;
  readonly leadsConfig: LeadsClientConfig;
  readonly axelorConfig: AxelorConfig;
  readonly pageLimit: number;
  readonly session: AxelorSessionClient;
  readonly fetchImpl: typeof fetch;
  readonly runId: number;
  readonly countryCode: string;
}

/**
 * Processes one country end to end: resumes from its persisted checkpoint
 * (reusing the AiSearch parent id if one already exists), then loops pages
 * until the Leads DB reports fewer rows than requested (exhaustion).
 *
 * The AiSearch parent is created lazily — only right before the first record
 * that actually needs it — so a country with zero data never triggers a
 * needless Axelor call. The checkpoint's `last_offset` advances once per
 * page, after every record in that page has been attempted (accepted
 * duplicate-risk decision — never per record).
 *
 * A per-record failure (Axelor rejects the create) is logged to
 * `import_errors` and processing continues with the next record. A failure
 * fetching the page itself (e.g. HTTP 500 from the Leads DB) is logged once
 * for the country (no record offset) and the country's checkpoint is marked
 * `failed`; the run continues with the next country.
 */
async function runCountryMigration(ctx: CountryMigrationContext): Promise<CountryMigrationSummary> {
  const { db, leadsConfig, axelorConfig, pageLimit, session, fetchImpl, runId, countryCode } = ctx;

  const checkpoint = upsertCheckpoint(db, runId, countryCode);
  const mappings = listFieldMappings(db, { sourceDb: countryCode, sourceTable: SOURCE_TABLE });

  let offset = checkpoint.lastOffset;
  let aiSearchId = checkpoint.aiSearchId;
  let processedCount = 0;
  let failedCount = 0;
  let finalStatus: MigrationCheckpointStatus = checkpoint.status;

  try {
    for (;;) {
      const page = await fetchCompaniesPage(leadsConfig, countryCode, pageLimit, offset);

      for (let index = 0; index < page.length; index += 1) {
        const rawRecord = page[index]!;
        try {
          if (aiSearchId === null) {
            const parent = await createAiSearch(
              session,
              axelorConfig,
              {
                statusSelect: 1,
                searchString: `Leads DB migration - ${countryCode}`,
                resultsNumber: 0,
              },
              fetchImpl,
            );
            aiSearchId = parent.id;
            setAiSearchId(db, checkpoint.id, aiSearchId);
          }

          const sanitized = sanitizeRecord(rawRecord);
          const payload = buildAiSearchResultsPayload(sanitized, mappings, aiSearchId);
          await createAiSearchResults(session, axelorConfig, payload, fetchImpl);
          processedCount += 1;
        } catch (error) {
          failedCount += 1;
          recordError(db, {
            runId,
            countryCode,
            recordOffset: offset + index,
            recordIdentifier: deriveRecordIdentifier(rawRecord),
            errorReason: errorMessage(error),
          });
        }
      }

      advanceOffset(db, checkpoint.id, offset + page.length);

      if (page.length < pageLimit) {
        setStatus(db, checkpoint.id, "completed");
        finalStatus = "completed";
        break;
      }

      offset += page.length;
    }
  } catch (error) {
    recordError(db, {
      runId,
      countryCode,
      recordOffset: null,
      recordIdentifier: null,
      errorReason: errorMessage(error),
    });
    setStatus(db, checkpoint.id, "failed");
    finalStatus = "failed";
  }

  return { countryCode, processedCount, failedCount, status: finalStatus };
}

/**
 * Runs (or resumes) a migration: sequentially, per country then per page,
 * sanitizes, maps, and creates each record in Axelor. See
 * `runCountryMigration` for the per-country resumption/failure contract.
 */
export async function runMigration(deps: MigrationEngineDeps): Promise<MigrationSummary> {
  const { db, leadsConfig, axelorConfig, pageLimit, session } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const runId = deps.runId ?? createRun(db).id;
  const countryCodes = deps.countries ?? getDefaultCountries(db);

  const countries: CountryMigrationSummary[] = [];
  for (const countryCode of countryCodes) {
    countries.push(
      await runCountryMigration({
        db,
        leadsConfig,
        axelorConfig,
        pageLimit,
        session,
        fetchImpl,
        runId,
        countryCode,
      }),
    );
  }

  updateRunStatus(db, runId, "completed");

  return { runId, countries };
}
