import type Database from "better-sqlite3";
import type { AxelorConfig } from "../config/env.js";
import type { LeadsClientConfig } from "../leads/leadsClient.js";
import { fetchCompaniesPage } from "../leads/leadsClient.js";
import type { AxelorSessionClient } from "../axelor/sessionClient.js";
import { createAiSearchResults } from "../axelor/restClient.js";
import { sanitizeRecord } from "../sanitize/sanitize.js";
import { buildAiSearchResultsPayload } from "./payloadBuilder.js";
import { listFieldMappings } from "../repos/mappingRepo.js";
import { upsertCheckpoint } from "../db/checkpointRepo.js";
import {
  getImportErrorById,
  markResolved,
  updateErrorReason,
  type ImportErrorRow,
} from "../db/importErrorRepo.js";
import { SOURCE_TABLE, createAiSearchParent, deriveRecordIdentifier } from "./engine.js";

/** Fixed re-fetch page size for a single-record retry — always exactly one row. */
const RETRY_FETCH_LIMIT = 1;

export interface RetrySingleRecordDeps {
  readonly db: Database.Database;
  readonly leadsConfig: LeadsClientConfig;
  readonly axelorConfig: AxelorConfig;
  readonly session: AxelorSessionClient;
  /** Injectable fetch implementation for Axelor REST calls. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export type RetryOutcome =
  | { readonly outcome: "not_found" }
  | { readonly outcome: "already_resolved"; readonly importError: ImportErrorRow }
  /**
   * Returned by `MigrationController.retry()` (never by `retrySingleRecord`
   * itself) when another retry for the same `errorId` is already in flight —
   * guards against the two HTTP surfaces (`/api/migration/errors/:id/retry`
   * and `/admin/api/errors/:id/retry`) racing the check-then-act sequence
   * below and duplicating the Axelor writes.
   */
  | { readonly outcome: "retry_in_progress" }
  | { readonly outcome: "resolved"; readonly importError: ImportErrorRow }
  | { readonly outcome: "failed"; readonly importError: ImportErrorRow; readonly reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Re-attempts a single failed `import_errors` row: re-fetches the record from
 * the Leads DB at its stored `(country_code, record_offset)` (no raw payload
 * is ever stored, so retry always re-fetches live data — an accepted known
 * limitation), re-runs the sanitize -> payload -> Axelor-create pipeline, and
 * marks the row resolved on success.
 *
 * If the re-fetched record's derived identifier differs from the stored
 * `record_identifier`, a warning is logged but the retry still completes
 * (SHOULD-level requirement — the source data may have legitimately shifted
 * since the original failure; this is non-blocking by design).
 *
 * If the country's checkpoint has no `aiSearchId` yet (its only record so far
 * failed before the parent was ever created), the `AiSearch` parent is
 * created on the spot via the same lazy-creation logic the engine uses, and
 * the new id is persisted onto the checkpoint before proceeding.
 *
 * A second failure is never silently swallowed: `updateErrorReason` records
 * the new failure reason and `resolved` stays `false`.
 */
export async function retrySingleRecord(
  deps: RetrySingleRecordDeps,
  errorId: number,
): Promise<RetryOutcome> {
  const { db, leadsConfig, axelorConfig, session } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const importError = getImportErrorById(db, errorId);
  if (importError === null) {
    return { outcome: "not_found" };
  }
  if (importError.resolved) {
    return { outcome: "already_resolved", importError };
  }

  try {
    const offset = importError.recordOffset ?? 0;
    const page = await fetchCompaniesPage(
      leadsConfig,
      importError.countryCode,
      RETRY_FETCH_LIMIT,
      offset,
    );
    const record = page[0];
    if (record === undefined) {
      throw new Error(
        `No record found at country=${importError.countryCode} offset=${offset} on retry re-fetch`,
      );
    }

    const reFetchedIdentifier = deriveRecordIdentifier(record);
    if (
      importError.recordIdentifier !== null &&
      reFetchedIdentifier !== importError.recordIdentifier
    ) {
      console.warn(
        `retrySingleRecord: re-fetched record identifier "${reFetchedIdentifier ?? "null"}" does not ` +
          `match stored record_identifier "${importError.recordIdentifier}" for import_errors id=${errorId} ` +
          `(country=${importError.countryCode}, offset=${offset}) — proceeding anyway (accepted known limitation)`,
      );
    }

    const checkpoint = upsertCheckpoint(db, importError.runId, importError.countryCode);
    const aiSearchId =
      checkpoint.aiSearchId ??
      (await createAiSearchParent(
        db,
        session,
        axelorConfig,
        checkpoint.id,
        importError.countryCode,
        fetchImpl,
      ));

    const mappings = listFieldMappings(db, {
      sourceDb: importError.countryCode,
      sourceTable: SOURCE_TABLE,
    });
    const sanitized = sanitizeRecord(record);
    const payload = buildAiSearchResultsPayload(sanitized, mappings, aiSearchId);
    await createAiSearchResults(session, axelorConfig, payload, fetchImpl);

    const resolved = markResolved(db, errorId);
    return { outcome: "resolved", importError: resolved ?? importError };
  } catch (error) {
    const reason = errorMessage(error);
    const updated = updateErrorReason(db, errorId, reason);
    return { outcome: "failed", importError: updated ?? importError, reason };
  }
}
