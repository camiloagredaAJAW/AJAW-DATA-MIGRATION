export type DestinationDomain = "AiSearchResults";
export type Confidence = "high" | "medium" | "low";

export interface DeducedField {
  readonly destinationField: string | null;
  readonly additionalInfoKey: string | null;
  readonly confidence: Confidence | null;
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
  matricula: "sourceRegistrationNumber",
};

export function taxIdAdditionalInfoKey(column: string): string | null {
  return TAX_ID_ADDITIONAL_INFO_KEYS[column] ?? null;
}

/**
 * Columns that are internal metadata (validation flags, quality scores,
 * match-confidence signals, internal join keys) with no reasonable Axelor
 * destination. These are intentionally left unmapped (destination_field:
 * null) rather than guessed into additionalInfo.
 *
 * `matricula`, `is_tourism`, and `is_supplement` are deliberately NOT in this
 * set: the ground-truth deduced dataset preserves them in additionalInfo
 * rather than leaving them unmapped (matricula via the tax-id key map above;
 * is_tourism/is_supplement via the generic additionalInfo fallback below).
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
 * Deduces the Axelor destination field for a single source column.
 *
 * Pure and deterministic: the same (column, sampleValues) pair always yields
 * the same result. `sampleValues` is accepted for signature parity with the
 * design and reserved for future value-based refinement, but every rule this
 * heuristic currently encodes (tax-id preservation, metadata exclusion,
 * name-based matching) is decidable from the column name alone.
 *
 * The Leads DB source now only exposes company data via `/companies` — there
 * is no person-lead endpoint — so every column deduces against the single
 * AiSearchResults (Company) domain unconditionally; no domain classification
 * step is needed.
 *
 * KNOWN LIMITATION (deferred, not fixed here): this function evaluates one
 * column at a time and cannot see sibling columns in the same schema, so it
 * cannot apply sibling-aware confidence downgrades (e.g. a secondary `phone2`
 * vs the primary `phone`, or `domain` vs an existing `website` column) the
 * way the curated ground-truth dataset does. `sample --refresh` on brand-new
 * columns may therefore return flat `high` confidence where the ground truth
 * would rate lower. This does not affect seed correctness, since the seed
 * loader reads confidence directly from the committed JSON and never calls
 * `deduce()`.
 *
 * Resolution order:
 * 1. Tax/record identifier columns -> additionalInfo + key
 * 2. Known metadata-only columns -> null (intentionally unmapped)
 * 3. Exact-name match against the known AiSearchResults fields -> that field
 * 4. No match -> additionalInfo with no key (generic preservation, low confidence)
 */
export function deduce(column: string, sampleValues: ReadonlyArray<unknown>): DeducedField {
  void sampleValues;

  const taxIdKey = taxIdAdditionalInfoKey(column);
  if (taxIdKey !== null) {
    return { destinationField: "additionalInfo", additionalInfoKey: taxIdKey, confidence: "medium" };
  }

  if (METADATA_ONLY_COLUMNS.has(column)) {
    return { destinationField: null, additionalInfoKey: null, confidence: null };
  }

  const matchedField = AI_SEARCH_RESULTS_FIELD_BY_COLUMN[column];
  if (matchedField !== undefined) {
    return { destinationField: matchedField, additionalInfoKey: null, confidence: "high" };
  }

  return { destinationField: "additionalInfo", additionalInfoKey: null, confidence: "low" };
}
