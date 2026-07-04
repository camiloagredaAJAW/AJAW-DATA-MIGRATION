export type DestinationDomain = "AiSearchResults" | "LinkedinSearchResults";
export type Confidence = "high" | "medium" | "low";

export interface DeducedField {
  readonly destinationField: string | null;
  readonly additionalInfoKey: string | null;
  readonly confidence: Confidence | null;
}

/**
 * source_db values that classify as the Person domain (LinkedinSearchResults).
 * Every other source_db classifies as the Company domain (AiSearchResults).
 * This is a locked, literal rule — applied uniformly even where the fit is
 * weak (e.g. contact_scrape has no LinkedIn-specific columns) and NOT applied
 * to near-miss names (e.g. domain_contacts stays Company).
 */
const PERSON_SOURCE_DBS: ReadonlySet<string> = new Set([
  "contact_ar",
  "contact_cl",
  "contact_ec",
  "contact_scrape",
]);

export function classifyDomain(sourceDb: string): DestinationDomain {
  return PERSON_SOURCE_DBS.has(sourceDb) ? "LinkedinSearchResults" : "AiSearchResults";
}

/**
 * Business/tax/record identifier columns that must be preserved in
 * additionalInfo rather than left unmapped, keyed by the additionalInfo
 * property they populate. Exact-name only: a column that merely contains one
 * of these words as a substring (e.g. `matched_nit`) does NOT match.
 */
const TAX_ID_ADDITIONAL_INFO_KEYS: Readonly<Record<string, string>> = {
  tax_id: "sourceTaxId",
  cuit: "sourceTaxId",
  nit: "sourceTaxId",
  cnpj: "sourceTaxId",
  rut: "sourceTaxId",
  cnpj_basico: "sourceTaxIdRoot",
  tax_id_type: "sourceTaxIdType",
  company_id: "sourceRecordId",
};

export function taxIdAdditionalInfoKey(column: string): string | null {
  return TAX_ID_ADDITIONAL_INFO_KEYS[column] ?? null;
}

/**
 * Columns that are internal metadata (validation flags, quality scores,
 * match-confidence signals, internal join keys) with no reasonable Axelor
 * destination. These are intentionally left unmapped (destination_field:
 * null) rather than guessed into additionalInfo.
 */
const METADATA_ONLY_COLUMNS: ReadonlySet<string> = new Set([
  "phone_valid",
  "phone_type",
  "rep_phone_valid",
  "rep_phone_type",
  "osm_phone_valid",
  "osm_phone_type",
  "osm_match_conf",
  "email_valid",
  "email_flag",
  "linked_to_company",
  "matched_nit",
  "matricula",
  "is_tourism",
  "is_supplement",
  "osm_type",
  "osm_id",
  "establishment",
  "expediente",
  "offer_id",
  "confidence",
  "score",
  "via",
  "cod_modular",
  "quality_score",
  "quality_tier",
]);

/** Exact-name matches for the AiSearchResults (Company) domain. */
const AI_SEARCH_RESULTS_FIELD_BY_COLUMN: Readonly<Record<string, string>> = {
  name: "title",
  company: "title",
  legal_name: "title",
  razon_social: "title",
  razao_social: "title",
  razao: "title",
  osm_name: "title",
  proveedor: "title",
  titular: "title",
  lead_name: "title",

  activity_code: "categoryName",
  activity_desc: "categoryName",
  categoria: "categoryName",
  category: "categoryName",
  cnae: "categoryName",
  clase: "categoryName",
  clasificacion: "categoryName",
  keytype: "categoryName",
  level: "categoryName",
  sector: "categoryName",
  servicio: "categoryName",
  sub_categoria: "categoryName",
  tourism_cat: "categoryName",

  address: "address",
  direccion: "address",

  city: "city",
  ciudad: "city",
  comuna: "city",
  dist: "city",
  localidad: "city",
  municipio: "city",
  lead_city: "city",

  state: "state",
  provincia: "state",
  departamento: "state",
  dept: "state",
  uf: "state",
  region: "state",

  postal_code: "postalCode",
  postcode: "postalCode",
  cep: "postalCode",

  country: "countryCode",

  phone: "phoneUnformatted",
  phone2: "phoneUnformatted",
  whatsapp: "phoneUnformatted",
  crawl_phone: "phoneUnformatted",
  crawl_whatsapp: "phoneUnformatted",
  e164: "phoneUnformatted",
  phone_e164: "phoneUnformatted",
  phone_landline: "phoneUnformatted",
  phone_mobile: "phoneUnformatted",
  osm_phone: "phoneUnformatted",
  osm_phone_landline: "phoneUnformatted",
  osm_phone_mobile: "phoneUnformatted",
  lead_phone: "phoneUnformatted",
  rep_phone: "phoneUnformatted",
  rep_phone_e164: "phoneUnformatted",
  rep_phone_landline: "phoneUnformatted",
  rep_phone_mobile: "phoneUnformatted",

  website: "website",
  web: "website",
  site: "website",
  domain: "website",
  osm_website: "website",

  email: "email",
  crawl_email: "email",
  email_generic: "email",
  osm_email: "email",
  rep_email: "email",

  neighborhood: "neighborhood",
  opening_hours: "openingHours",
};

/**
 * Exact-name matches for the LinkedinSearchResults (Person) domain. Only
 * contact_scrape has been sampled so far, so this map is intentionally small
 * — it grows as new Person tables (contact_ar/cl/ec) are sampled with data.
 */
const LINKEDIN_SEARCH_RESULTS_FIELD_BY_COLUMN: Readonly<Record<string, string>> = {
  email: "email",
  phone: "phone",
  phone_landline: "phone",
  phone_mobile: "phone",
  whatsapp: "phone",
  status: "description",
  website: "link",
};

function fieldMapForDomain(domain: DestinationDomain): Readonly<Record<string, string>> {
  return domain === "LinkedinSearchResults"
    ? LINKEDIN_SEARCH_RESULTS_FIELD_BY_COLUMN
    : AI_SEARCH_RESULTS_FIELD_BY_COLUMN;
}

/**
 * Deduces the Axelor destination field for a single source column.
 *
 * Pure and deterministic: the same (column, domain) pair always yields the
 * same result. `sampleValues` is accepted for signature parity with the
 * design (`deduce(column, sampleValues, domain)`) and reserved for future
 * value-based refinement, but every rule this heuristic currently encodes
 * (tax-id preservation, metadata exclusion, name-based matching) is
 * decidable from the column name alone.
 *
 * Resolution order:
 * 1. Tax/record identifier columns -> additionalInfo + key (domain-agnostic)
 * 2. Known metadata-only columns -> null (intentionally unmapped)
 * 3. Exact-name match against the domain's known Axelor fields -> that field
 * 4. No match -> additionalInfo with no key (generic preservation, low confidence)
 */
export function deduce(
  column: string,
  sampleValues: ReadonlyArray<unknown>,
  domain: DestinationDomain,
): DeducedField {
  void sampleValues;

  const taxIdKey = taxIdAdditionalInfoKey(column);
  if (taxIdKey !== null) {
    return { destinationField: "additionalInfo", additionalInfoKey: taxIdKey, confidence: "medium" };
  }

  if (METADATA_ONLY_COLUMNS.has(column)) {
    return { destinationField: null, additionalInfoKey: null, confidence: null };
  }

  const matchedField = fieldMapForDomain(domain)[column];
  if (matchedField !== undefined) {
    return { destinationField: matchedField, additionalInfoKey: null, confidence: "high" };
  }

  return { destinationField: "additionalInfo", additionalInfoKey: null, confidence: "low" };
}
