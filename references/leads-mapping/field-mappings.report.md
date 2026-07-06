# Leads DB -> Axelor Field Mapping Report (v2 — per-country /companies endpoint)

Supersedes the original per-source_db/source_table mapping. The Leads DB source changed to a single `/companies?country=<CODE>&has_phone=1&has_email=1` endpoint, iterated over country codes only. Person domain (LinkedinSearch/LinkedinSearchResults) is out of scope — every row here targets `AiSearchResults`.

- Countries with live sample data (`limit=3`): **7** (BR, CO, GT, HN, MX, PA, UY)
- Countries with 0 rows this session (expected — "only already-scraped data" is exposed): **8** (AR, BO, CL, CR, DO, EC, PE, PY)
- Countries that returned a 500 error on sampling: **2** (NI, SV) — matches the old catalog's `databases` entries being empty (`ni: []`, `sv: []`); re-check once the source has data for them.
- Total distinct source columns observed: **163**
- Mapped to a destination field: **156**
- Unmapped (`destination_field: null`): **7** (all legitimate internal metadata: match-confidence scores, phone-validation flags)

## Per-country column counts

| country | columns | mapped | unmapped |
|---|---|---|---|
| BR | 20 | 20 | 0 |
| CO | 36 | 33 | 3 |
| GT | 17 | 17 | 0 |
| HN | 17 | 17 | 0 |
| MX | 39 | 35 | 4 |
| PA | 17 | 17 | 0 |
| UY | 17 | 17 | 0 |

## Business identifiers preserved in additionalInfo

| country | source_column | additionalInfo key |
|---|---|---|
| BR | cnpj | sourceTaxId |
| BR | cnpj_basico | sourceTaxIdRoot |
| CO | company_id | sourceRecordId |
| CO | matricula | sourceRegistrationNumber |
| CO | tax_id | sourceTaxId |
| CO | tax_id_type | sourceTaxIdType |
| GT | company_id | sourceRecordId |
| GT | tax_id | sourceTaxId |
| GT | tax_id_type | sourceTaxIdType |
| HN | company_id | sourceRecordId |
| HN | tax_id | sourceTaxId |
| HN | tax_id_type | sourceTaxIdType |
| MX | company_id | sourceRecordId |
| MX | tax_id | sourceTaxId |
| MX | tax_id_type | sourceTaxIdType |
| PA | company_id | sourceRecordId |
| PA | tax_id | sourceTaxId |
| PA | tax_id_type | sourceTaxIdType |
| UY | company_id | sourceRecordId |
| UY | tax_id | sourceTaxId |
| UY | tax_id_type | sourceTaxIdType |

## Low/medium-confidence mappings (review recommended)

| country | source_column | destination_field | confidence | note |
|---|---|---|---|---|
| BR | activity_code | additionalInfo | medium | coded activity classification, not human-readable category text |
| BR | cnpj | additionalInfo | medium | Preserved as additionalInfo.sourceTaxId - business identifier, no dedicated Axelor field. |
| BR | cnpj_basico | additionalInfo | medium | Preserved as additionalInfo.sourceTaxIdRoot - business identifier, no dedicated Axelor field. |
| BR | company_size | additionalInfo | low | company size classification, no dedicated field |
| BR | legal_form_code | additionalInfo | low | legal form classification code |
| BR | phone2 | phoneUnformatted | low | secondary phone line; duplicate candidate alongside the primary phone column |
| BR | porte_code | additionalInfo | low | company size classification code (Brazil porte) |
| BR | share_capital | additionalInfo | low | registered share capital amount, no dedicated field |
| BR | status | additionalInfo | medium | company/registration status text (e.g. ATIVA/CANCELADA/supplier), not a scraping-error state |
| BR | trade_name | additionalInfo | medium | secondary/trade name, AiSearchResults has only one title field |
| CO | activity_code | additionalInfo | medium | coded activity classification, not human-readable category text |
| CO | assets | additionalInfo | low | financial statement figure (assets), no dedicated field |
| CO | chamber | additionalInfo | low | chamber-of-commerce jurisdiction name |
| CO | company_id | additionalInfo | medium | Preserved as additionalInfo.sourceRecordId - business identifier, no dedicated Axelor field. |
| CO | company_size | additionalInfo | low | company size classification, no dedicated field |
| CO | equity | additionalInfo | low | financial statement figure (equity), no dedicated field |
| CO | hiring_role | additionalInfo | low | hiring-signal role text, no dedicated field |
| CO | hiring_sales | additionalInfo | low | hiring-signal flag (sales role open), no dedicated field |
| CO | is_supplement | additionalInfo | low | boolean enrichment flag, no dedicated field |
| CO | is_tourism | additionalInfo | low | boolean enrichment flag, no dedicated field |
| CO | last_renewed | additionalInfo | low | last renewal year/date |
| CO | legal_nature | additionalInfo | low | legal nature classification (e.g. PERSONA NATURAL) |
| CO | matricula | additionalInfo | medium | Preserved as additionalInfo.sourceRegistrationNumber - business identifier, no dedicated Axelor field. |
| CO | net_profit | additionalInfo | low | financial statement figure (net profit), no dedicated field |
| CO | osm_email | email | low | OSM cross-reference email; secondary/enrichment candidate |
| CO | osm_phone | phoneUnformatted | low | OpenStreetMap cross-reference phone; secondary/enrichment candidate |
| CO | osm_phone_landline | phoneUnformatted | low | OSM cross-reference normalized landline phone; duplicate candidate |
| CO | osm_phone_mobile | phoneUnformatted | low | OSM cross-reference normalized mobile phone; duplicate candidate |
| CO | osm_website | website | low | OSM cross-reference website; secondary/enrichment candidate |
| CO | revenue | additionalInfo | low | financial statement figure (revenue), no dedicated field |
| CO | secop_contracts | additionalInfo | low | government-contracts count signal (SECOP), no dedicated field |
| CO | secop_total | additionalInfo | low | government-contracts total value signal (SECOP), no dedicated field |
| CO | source | additionalInfo | low | data provenance/source system name, useful metadata only |
| CO | source_date | additionalInfo | low | data snapshot/extraction date, metadata only |
| CO | status | additionalInfo | medium | company/registration status text (e.g. ATIVA/CANCELADA/supplier), not a scraping-error state |
| CO | tax_id | additionalInfo | medium | Preserved as additionalInfo.sourceTaxId - business identifier, no dedicated Axelor field. |
| CO | tax_id_type | additionalInfo | medium | Preserved as additionalInfo.sourceTaxIdType - business identifier, no dedicated Axelor field. |
| CO | tourism_cat | categoryName | low | tourism category classification, alternate to sector/activity |
| GT | activity_code | additionalInfo | medium | coded activity classification, not human-readable category text |
| GT | company_id | additionalInfo | medium | Preserved as additionalInfo.sourceRecordId - business identifier, no dedicated Axelor field. |
| GT | source | additionalInfo | low | data provenance/source system name, useful metadata only |
| GT | source_date | additionalInfo | low | data snapshot/extraction date, metadata only |
| GT | status | additionalInfo | medium | company/registration status text (e.g. ATIVA/CANCELADA/supplier), not a scraping-error state |
| GT | tax_id | additionalInfo | medium | Preserved as additionalInfo.sourceTaxId - business identifier, no dedicated Axelor field. |
| GT | tax_id_type | additionalInfo | medium | Preserved as additionalInfo.sourceTaxIdType - business identifier, no dedicated Axelor field. |
| GT | trade_name | additionalInfo | medium | secondary/trade name, AiSearchResults has only one title field |
| HN | activity_code | additionalInfo | medium | coded activity classification, not human-readable category text |
| HN | company_id | additionalInfo | medium | Preserved as additionalInfo.sourceRecordId - business identifier, no dedicated Axelor field. |
| HN | source | additionalInfo | low | data provenance/source system name, useful metadata only |
| HN | source_date | additionalInfo | low | data snapshot/extraction date, metadata only |
| HN | status | additionalInfo | medium | company/registration status text (e.g. ATIVA/CANCELADA/supplier), not a scraping-error state |
| HN | tax_id | additionalInfo | medium | Preserved as additionalInfo.sourceTaxId - business identifier, no dedicated Axelor field. |
| HN | tax_id_type | additionalInfo | medium | Preserved as additionalInfo.sourceTaxIdType - business identifier, no dedicated Axelor field. |
| HN | trade_name | additionalInfo | medium | secondary/trade name, AiSearchResults has only one title field |
| MX | activity_code | additionalInfo | medium | coded activity classification, not human-readable category text |
| MX | activity_desc | categoryName | medium | human-readable activity description, alternate to sector |
| MX | company_id | additionalInfo | medium | Preserved as additionalInfo.sourceRecordId - business identifier, no dedicated Axelor field. |
| MX | crawl_email | email | low | web-crawl-derived email; secondary/enrichment candidate |
| MX | crawl_phone | phoneUnformatted | low | web-crawl-derived phone; secondary/enrichment candidate |
| MX | crawl_whatsapp | phoneUnformatted | low | web-crawl-derived WhatsApp number; secondary/enrichment candidate |
| MX | created_at | additionalInfo | low | record creation timestamp, metadata only |
| MX | domain | additionalInfo | medium | raw domain string, distinct from the website column already present |
| MX | email_generic | email | medium | secondary/generic email candidate alongside the primary email column |
| MX | employee_band | additionalInfo | low | employee count band, no dedicated field |
| MX | hiring_role | additionalInfo | low | hiring-signal role text, no dedicated field |
| MX | hiring_sales | additionalInfo | low | hiring-signal flag (sales role open), no dedicated field |
| MX | lat | additionalInfo | low | geo-coordinate (latitude); no dedicated lat/lng field |
| MX | lng | additionalInfo | low | geo-coordinate (longitude); no dedicated lat/lng field |
| MX | osm_email | email | low | OSM cross-reference email; secondary/enrichment candidate |
| MX | osm_phone | phoneUnformatted | low | OpenStreetMap cross-reference phone; secondary/enrichment candidate |
| MX | osm_website | website | low | OSM cross-reference website; secondary/enrichment candidate |
| MX | phone_landline | phoneUnformatted | low | normalized landline phone; duplicate candidate to the primary phone column |
| MX | phone_mobile | phoneUnformatted | low | normalized mobile phone; duplicate candidate to the primary phone column |
| MX | source | additionalInfo | low | data provenance/source system name, useful metadata only |
| MX | source_date | additionalInfo | low | data snapshot/extraction date, metadata only |
| MX | status | additionalInfo | medium | company/registration status text (e.g. ATIVA/CANCELADA/supplier), not a scraping-error state |
| MX | tax_id | additionalInfo | medium | Preserved as additionalInfo.sourceTaxId - business identifier, no dedicated Axelor field. |
| MX | tax_id_type | additionalInfo | medium | Preserved as additionalInfo.sourceTaxIdType - business identifier, no dedicated Axelor field. |
| MX | trade_name | additionalInfo | medium | secondary/trade name, AiSearchResults has only one title field |
| PA | activity_code | additionalInfo | medium | coded activity classification, not human-readable category text |
| PA | company_id | additionalInfo | medium | Preserved as additionalInfo.sourceRecordId - business identifier, no dedicated Axelor field. |
| PA | source | additionalInfo | low | data provenance/source system name, useful metadata only |
| PA | source_date | additionalInfo | low | data snapshot/extraction date, metadata only |
| PA | status | additionalInfo | medium | company/registration status text (e.g. ATIVA/CANCELADA/supplier), not a scraping-error state |
| PA | tax_id | additionalInfo | medium | Preserved as additionalInfo.sourceTaxId - business identifier, no dedicated Axelor field. |
| PA | tax_id_type | additionalInfo | medium | Preserved as additionalInfo.sourceTaxIdType - business identifier, no dedicated Axelor field. |
| PA | trade_name | additionalInfo | medium | secondary/trade name, AiSearchResults has only one title field |
| UY | activity_code | additionalInfo | medium | coded activity classification, not human-readable category text |
| UY | company_id | additionalInfo | medium | Preserved as additionalInfo.sourceRecordId - business identifier, no dedicated Axelor field. |
| UY | source | additionalInfo | low | data provenance/source system name, useful metadata only |
| UY | source_date | additionalInfo | low | data snapshot/extraction date, metadata only |
| UY | status | additionalInfo | medium | company/registration status text (e.g. ATIVA/CANCELADA/supplier), not a scraping-error state |
| UY | tax_id | additionalInfo | medium | Preserved as additionalInfo.sourceTaxId - business identifier, no dedicated Axelor field. |
| UY | tax_id_type | additionalInfo | medium | Preserved as additionalInfo.sourceTaxIdType - business identifier, no dedicated Axelor field. |
| UY | trade_name | additionalInfo | medium | secondary/trade name, AiSearchResults has only one title field |

## Unmapped columns

| country | source_column | note |
|---|---|---|
| CO | osm_match_conf | match-confidence score for OSM cross-reference, metadata only |
| CO | osm_phone_type | phone classification metadata for OSM cross-reference |
| CO | osm_phone_valid | boolean phone-validation flag for OSM cross-reference, metadata only |
| MX | confidence | internal match-confidence score/label, metadata only |
| MX | osm_match_conf | match-confidence score for OSM cross-reference, metadata only |
| MX | phone_type | phone classification metadata (FIXED/MOBILE/etc.) |
| MX | phone_valid | boolean phone-validation flag, metadata only |

## Notable per-country schema observations

- **BR**: `city` came back as a numeric internal code (e.g. `"2951"`), not a city name — mapped to `city` anyway (matches the destination field's intent) but flagged here since it will display as a code in Axelor until/unless a lookup table is introduced.
- **CO**: richest schema of the sampled countries — merges what used to be separate `colombia_rues`/`co_prov`/`co_signals`/OSM sources into one record (chamber-of-commerce, financials, SECOP government-contract signals, tourism flags, OSM cross-references all present together).
- **GT / HN / PA / UY**: share an identical generic schema (17 columns) — GT/HN/PA are sourced from national government-procurement portals (`source` values like "Guatecompras OCDS", "HonduCompras OCDS", "PanamaCompra OCDS"), so `status` for these countries reads as `"supplier"` rather than a registration status like Brazil/Colombia's.
- **MX**: includes geo-coordinates (`lat`/`lng`), web-crawl-derived contact enrichment (`crawl_email`/`crawl_phone`/`crawl_whatsapp`), and both `activity_code` + `activity_desc` + `sector` (three separate category-like fields) — `sector` was chosen as primary `categoryName`, `activity_desc` as a lower-confidence alternate, `activity_code` preserved in `additionalInfo` since it is a coded value, not human-readable text.
- **NI / SV**: the `/companies` endpoint returned an HTTP 500 for both — consistent with the old catalog showing empty table lists for these two countries (no data ever scraped). Not a mapping gap, a data-availability gap; re-sample once the source has data.
- **AR / BO / CL / CR / DO / EC / PE / PY**: returned 0 rows this session (valid empty response, no error) — same "only this session's scraped databases are exposed" behavior seen with the original endpoint. Re-sample later via `--refresh` once data exists.
