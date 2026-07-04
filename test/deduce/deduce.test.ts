import { describe, expect, it } from "vitest";
import { classifyDomain, deduce, taxIdAdditionalInfoKey } from "../../src/deduce/deduce.js";

describe("classifyDomain", () => {
  it("classifies known Person source_db values as LinkedinSearchResults", () => {
    expect(classifyDomain("contact_ar")).toBe("LinkedinSearchResults");
    expect(classifyDomain("contact_cl")).toBe("LinkedinSearchResults");
    expect(classifyDomain("contact_ec")).toBe("LinkedinSearchResults");
    expect(classifyDomain("contact_scrape")).toBe("LinkedinSearchResults");
  });

  it("classifies every other source_db as AiSearchResults, even weak/near-miss names", () => {
    expect(classifyDomain("ar")).toBe("AiSearchResults");
    expect(classifyDomain("domain_contacts")).toBe("AiSearchResults");
  });
});

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
  });

  it("returns null for a column that merely contains a tax-id substring", () => {
    // 'matched_nit' is an internal join flag, not a tax identifier itself.
    expect(taxIdAdditionalInfoKey("matched_nit")).toBeNull();
  });
});

describe("deduce", () => {
  it("routes tax/record identifier columns into additionalInfo with their key, regardless of domain", () => {
    const result = deduce("cnpj", [], "AiSearchResults");
    expect(result.destinationField).toBe("additionalInfo");
    expect(result.additionalInfoKey).toBe("sourceTaxId");
    expect(result.confidence).toBe("medium");
  });

  it("reproduces known high-confidence exact-name matches from the real deduced dataset", () => {
    expect(deduce("legal_name", [], "AiSearchResults")).toEqual({
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
    });
    expect(deduce("country", [], "AiSearchResults")).toEqual({
      destinationField: "countryCode",
      additionalInfoKey: null,
      confidence: "high",
    });
    expect(deduce("website", [], "AiSearchResults")).toEqual({
      destinationField: "website",
      additionalInfoKey: null,
      confidence: "high",
    });
  });

  it("leaves known metadata-only columns unmapped (destination_field null)", () => {
    expect(deduce("phone_valid", [], "AiSearchResults")).toEqual({
      destinationField: null,
      additionalInfoKey: null,
      confidence: null,
    });
    expect(deduce("quality_tier", [], "AiSearchResults")).toEqual({
      destinationField: null,
      additionalInfoKey: null,
      confidence: null,
    });
  });

  it("falls back to additionalInfo (no key) for an ambiguous column with no reasonable match", () => {
    const result = deduce("some_never_seen_column", [], "AiSearchResults");
    expect(result.destinationField).toBe("additionalInfo");
    expect(result.additionalInfoKey).toBeNull();
    expect(result.confidence).toBe("low");
  });

  it("applies domain-specific field maps: the same column can resolve differently per domain", () => {
    expect(deduce("website", [], "LinkedinSearchResults").destinationField).toBe("link");
    expect(deduce("status", [], "LinkedinSearchResults").destinationField).toBe("description");
    expect(deduce("website", [], "AiSearchResults").destinationField).toBe("website");
  });

  it("is deterministic: identical inputs always produce identical output", () => {
    const a = deduce("legal_name", [], "AiSearchResults");
    const b = deduce("legal_name", [], "AiSearchResults");
    expect(a).toEqual(b);
  });
});
