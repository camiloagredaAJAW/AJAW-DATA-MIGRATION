import { describe, expect, it } from "vitest";
import { deduce, taxIdAdditionalInfoKey } from "../../src/deduce/deduce.js";

describe("taxIdAdditionalInfoKey", () => {
  it("maps known tax/record identifier columns to their additionalInfo key", () => {
    expect(taxIdAdditionalInfoKey("tax_id")).toBe("sourceTaxId");
    expect(taxIdAdditionalInfoKey("cuit")).toBe("sourceTaxId");
    expect(taxIdAdditionalInfoKey("nit")).toBe("sourceTaxId");
    expect(taxIdAdditionalInfoKey("cnpj")).toBe("sourceTaxId");
    expect(taxIdAdditionalInfoKey("rut")).toBe("sourceTaxId");
    expect(taxIdAdditionalInfoKey("cnpj_basico")).toBe("sourceTaxIdRoot");
    expect(taxIdAdditionalInfoKey("tax_id_type")).toBe("sourceTaxIdType");
    expect(taxIdAdditionalInfoKey("company_id")).toBe("sourceRecordId");
    expect(taxIdAdditionalInfoKey("matricula")).toBe("sourceRegistrationNumber");
  });

  it("returns null for a column that merely contains a tax-id substring", () => {
    // 'matched_nit' is an internal join flag, not a tax identifier itself.
    expect(taxIdAdditionalInfoKey("matched_nit")).toBeNull();
  });
});

describe("deduce", () => {
  it("routes tax/record identifier columns into additionalInfo with their key", () => {
    const result = deduce("cnpj", []);
    expect(result.destinationField).toBe("additionalInfo");
    expect(result.additionalInfoKey).toBe("sourceTaxId");
    expect(result.confidence).toBe("medium");
  });

  it("routes matricula into additionalInfo.sourceRegistrationNumber instead of leaving it unmapped", () => {
    const result = deduce("matricula", []);
    expect(result.destinationField).toBe("additionalInfo");
    expect(result.additionalInfoKey).toBe("sourceRegistrationNumber");
    expect(result.confidence).toBe("medium");
  });

  it("routes is_tourism into generic additionalInfo (no dedicated key) instead of leaving it unmapped", () => {
    const result = deduce("is_tourism", []);
    expect(result.destinationField).toBe("additionalInfo");
    expect(result.additionalInfoKey).toBeNull();
  });

  it("routes is_supplement into generic additionalInfo (no dedicated key) instead of leaving it unmapped", () => {
    const result = deduce("is_supplement", []);
    expect(result.destinationField).toBe("additionalInfo");
    expect(result.additionalInfoKey).toBeNull();
  });

  it("reproduces known high-confidence exact-name matches from the real deduced dataset", () => {
    expect(deduce("legal_name", [])).toEqual({
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
    });
    expect(deduce("country", [])).toEqual({
      destinationField: "countryCode",
      additionalInfoKey: null,
      confidence: "high",
    });
    expect(deduce("website", [])).toEqual({
      destinationField: "website",
      additionalInfoKey: null,
      confidence: "high",
    });
  });

  it("leaves known metadata-only columns unmapped (destination_field null)", () => {
    expect(deduce("phone_valid", [])).toEqual({
      destinationField: null,
      additionalInfoKey: null,
      confidence: null,
    });
    expect(deduce("quality_tier", [])).toEqual({
      destinationField: null,
      additionalInfoKey: null,
      confidence: null,
    });
  });

  it("falls back to additionalInfo (no key) for an ambiguous column with no reasonable match", () => {
    const result = deduce("some_never_seen_column", []);
    expect(result.destinationField).toBe("additionalInfo");
    expect(result.additionalInfoKey).toBeNull();
    expect(result.confidence).toBe("low");
  });

  it("is deterministic: identical inputs always produce identical output", () => {
    const a = deduce("legal_name", []);
    const b = deduce("legal_name", []);
    expect(a).toEqual(b);
  });

  // Deferred (documented, not fixed here): deduce() evaluates one column at a
  // time and cannot see sibling columns in the same schema, so it cannot
  // downgrade confidence for secondary/duplicate-looking columns the way the
  // curated ground-truth dataset does. These assertions pin the CURRENT
  // (imperfect) behavior, not the ideal sibling-aware behavior — see spec's
  // "Deferred / Out of Scope" note.
  it("[deferred limitation] does not downgrade confidence for sibling-like secondary columns", () => {
    expect(deduce("phone2", []).confidence).toBe("high");
    expect(deduce("domain", []).confidence).toBe("high");
    expect(deduce("crawl_phone", []).confidence).toBe("high");
    expect(deduce("osm_website", []).confidence).toBe("high");
    expect(deduce("activity_desc", []).confidence).toBe("high");
    expect(deduce("tourism_cat", []).confidence).toBe("high");
  });
});
