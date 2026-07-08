/**
 * Shared parser for Axelor's PUT-create response envelope:
 * `{ status: 0, data: [{ id, ...fields }] }` on success. Consolidated here so
 * `createAiSearch` and `createAiSearchResults` share one parsing rule instead
 * of duplicating the `status:0` / `data[0].id` checks.
 */
export function parsePutEnvelope(body: unknown, modelName: string): { id: number } {
  const envelope = body as { status?: number; data?: Array<{ id?: number }> };

  if (envelope.status !== 0) {
    throw new Error(`Axelor rejected the create for ${modelName}: status ${envelope.status}`);
  }

  const record = envelope.data?.[0];
  if (record === undefined || typeof record.id !== "number") {
    throw new Error(`Axelor create response for ${modelName} did not include a record id`);
  }

  return { id: record.id };
}

/** A fully-populated `AiSearch` record as returned by a GET or POST(update) call. */
export interface AiSearchEnvelopeRecord {
  readonly id: number;
  readonly version: number;
  readonly statusSelect: number;
  readonly resultsNumber: number;
}

/**
 * Sibling parser for `AiSearch` GET/POST(update) response envelopes. Shares
 * `parsePutEnvelope`'s `{ status: 0, data: [{...}] }` shape, but additionally
 * validates and extracts `version`, `statusSelect`, and `resultsNumber` (not
 * just `id`), since the AiSearch progress-push flow reads those fields
 * straight off the response. Kept separate from `parsePutEnvelope` so its
 * existing create-only callers/contract stay untouched.
 */
export function parseAiSearchEnvelope(body: unknown, modelName: string): AiSearchEnvelopeRecord {
  const envelope = body as {
    status?: number;
    data?: Array<{
      id?: number;
      version?: number;
      statusSelect?: number;
      resultsNumber?: number;
    }>;
  };

  if (envelope.status !== 0) {
    throw new Error(`Axelor rejected the request for ${modelName}: status ${envelope.status}`);
  }

  const record = envelope.data?.[0];
  if (
    record === undefined ||
    typeof record.id !== "number" ||
    typeof record.version !== "number" ||
    typeof record.statusSelect !== "number" ||
    typeof record.resultsNumber !== "number"
  ) {
    throw new Error(`Axelor response for ${modelName} did not include a complete AiSearch record`);
  }

  return {
    id: record.id,
    version: record.version,
    statusSelect: record.statusSelect,
    resultsNumber: record.resultsNumber,
  };
}
