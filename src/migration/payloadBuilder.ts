import type { FieldMappingRow } from "../repos/mappingRepo.js";

export interface AiSearchResultsPayload {
  [field: string]: string | { id: number };
  aiSearch: { id: number };
}

/**
 * Destination fields on AiSearchResults that are stored as a single JSON
 * blob (`json="true"` in the Axelor domain model) and therefore collect
 * multiple source columns into one object before being JSON.stringify'd.
 */
const JSON_GROUPED_FIELDS = new Set(["additionalInfo", "openingHours"]);

/**
 * Builds the `AiSearchResults` create payload for one sanitized record using
 * the country's `field_mappings` rows.
 *
 * - Rows with `destinationField === null` (unmapped) are skipped entirely —
 *   no key is ever sent, not even a literal `"null"` (LOCKED decision).
 * - Direct fields are only set when the record has a non-null/non-undefined
 *   value for the mapped `sourceColumn`.
 * - Rows targeting a JSON-grouped field (`additionalInfo`, `openingHours`)
 *   are collected into one object keyed by `additionalInfoKey` (falling back
 *   to `sourceColumn`), then `JSON.stringify`'d. The grouped field is omitted
 *   entirely if none of its mapped columns had a value.
 * - `aiSearch: { id: aiSearchId }` is always attached, regardless of mappings.
 */
export function buildAiSearchResultsPayload(
  record: Record<string, unknown>,
  mappings: readonly FieldMappingRow[],
  aiSearchId: number,
): AiSearchResultsPayload {
  const payload: Record<string, string | { id: number }> = {};
  const grouped = new Map<string, Record<string, unknown>>();

  for (const mapping of mappings) {
    if (mapping.destinationField === null) {
      continue;
    }

    const value = record[mapping.sourceColumn];
    if (value === null || value === undefined) {
      continue;
    }

    if (JSON_GROUPED_FIELDS.has(mapping.destinationField)) {
      const bucket = grouped.get(mapping.destinationField) ?? {};
      bucket[mapping.additionalInfoKey ?? mapping.sourceColumn] = value;
      grouped.set(mapping.destinationField, bucket);
      continue;
    }

    payload[mapping.destinationField] = String(value);
  }

  for (const [field, values] of grouped) {
    if (Object.keys(values).length > 0) {
      payload[field] = JSON.stringify(values);
    }
  }

  return { ...payload, aiSearch: { id: aiSearchId } };
}
