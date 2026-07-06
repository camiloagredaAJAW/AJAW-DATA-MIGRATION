import { describe, expect, it } from "vitest";
import { buildAiSearchResultsPayload } from "../../src/migration/payloadBuilder.js";
import type { FieldMappingRow } from "../../src/repos/mappingRepo.js";

function mappingRow(overrides: Partial<FieldMappingRow>): FieldMappingRow {
  return {
    id: 1,
    sourceDb: "AR",
    sourceTable: "companies",
    sourceColumn: "legal_name",
    destinationDomain: "AiSearchResults",
    destinationField: "title",
    additionalInfoKey: null,
    transform: null,
    confidence: "high",
    note: null,
    origin: "seed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildAiSearchResultsPayload", () => {
  it("includes a direct destination field when the record has a value for the mapped source column", () => {
    const record = { legal_name: "ACME Corp" };
    const mappings = [mappingRow({ sourceColumn: "legal_name", destinationField: "title" })];

    const payload = buildAiSearchResultsPayload(record, mappings, 42);

    expect(payload.title).toBe("ACME Corp");
  });

  it("omits a destination field entirely when the mapping has no destination_field (unmapped)", () => {
    const record = { legal_name: "ACME Corp", internal_code: "X123" };
    const mappings = [
      mappingRow({ sourceColumn: "legal_name", destinationField: "title" }),
      mappingRow({ id: 2, sourceColumn: "internal_code", destinationField: null }),
    ];

    const payload = buildAiSearchResultsPayload(record, mappings, 42);

    expect(payload).not.toHaveProperty("internal_code");
  });

  it("collects all additionalInfo-mapped columns into one JSON-stringified object keyed by additional_info_key", () => {
    const record = { cnpj: "123", company_size: "large" };
    const mappings = [
      mappingRow({
        id: 3,
        sourceColumn: "cnpj",
        destinationField: "additionalInfo",
        additionalInfoKey: "sourceTaxId",
      }),
      mappingRow({
        id: 4,
        sourceColumn: "company_size",
        destinationField: "additionalInfo",
        additionalInfoKey: null,
      }),
    ];

    const payload = buildAiSearchResultsPayload(record, mappings, 42);

    expect(typeof payload.additionalInfo).toBe("string");
    expect(JSON.parse(payload.additionalInfo as string)).toEqual({
      sourceTaxId: "123",
      company_size: "large",
    });
  });

  it("always attaches aiSearch.id regardless of field mappings", () => {
    const payload = buildAiSearchResultsPayload({}, [], 99);

    expect(payload.aiSearch).toEqual({ id: 99 });
  });

  it("omits a mapped destination field when the record's source value is null", () => {
    const record = { legal_name: null };
    const mappings = [mappingRow({ sourceColumn: "legal_name", destinationField: "title" })];

    const payload = buildAiSearchResultsPayload(record, mappings, 1);

    expect(payload).not.toHaveProperty("title");
  });

  it("omits additionalInfo entirely when none of the mapped columns have a value", () => {
    const record = { cnpj: null };
    const mappings = [
      mappingRow({
        sourceColumn: "cnpj",
        destinationField: "additionalInfo",
        additionalInfoKey: "sourceTaxId",
      }),
    ];

    const payload = buildAiSearchResultsPayload(record, mappings, 1);

    expect(payload).not.toHaveProperty("additionalInfo");
  });
});
