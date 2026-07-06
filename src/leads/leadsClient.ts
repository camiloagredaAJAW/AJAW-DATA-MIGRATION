import { parseJsonLines } from "./parseJsonLines.js";

export interface LeadsClientConfig {
  readonly baseUrl: string;
  readonly dbsPath: string;
  readonly companiesPath: string;
  readonly keyValue: string;
  /** Per-request timeout in ms. Defaults to 60s — some countries have been observed to take up to ~45s. */
  readonly timeoutMs?: number;
  /** Injectable fetch implementation, defaults to the global fetch. Lets tests avoid touching the real network. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A source_catalog pair. The Leads DB now exposes exactly one table
 * (`companies`) per country, so `sourceDb` is always a country code and
 * `sourceTable` is always the constant `"companies"`. The pair shape is kept
 * (schema-continuity decision) to avoid churn in source_catalog, the diff
 * logic, and downstream consumers — only the *meaning* of the pair changed.
 */
export interface LeadsCatalogEntry {
  readonly sourceDb: string;
  readonly sourceTable: string;
}

/** Result of sampling one country's `companies` data. `sourceDb` is the country code. */
export interface TableSampleOutcome {
  readonly sourceDb: string;
  readonly sourceTable: string;
  readonly rows: Record<string, unknown>[];
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SAMPLE_LIMIT = 3;

function resolveFetch(config: LeadsClientConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}

async function withTimeout<T>(
  config: LeadsClientConfig,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches the Leads DB catalog (`/dbs`) and flattens the `countries` object's
 * keys into source_db/source_table pairs (`sourceTable` is always
 * `"companies"`). The legacy `databases` object is obsolete and ignored.
 */
export async function fetchCatalog(config: LeadsClientConfig): Promise<LeadsCatalogEntry[]> {
  const url = `${config.baseUrl}/${config.dbsPath}?key=${encodeURIComponent(config.keyValue)}`;
  const doFetch = resolveFetch(config);

  return withTimeout(config, async (signal) => {
    const response = await doFetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Leads DB catalog request failed with status ${response.status}`);
    }
    const body = (await response.json()) as { countries?: Record<string, unknown> };
    return Object.keys(body.countries ?? {}).map((countryCode) => ({
      sourceDb: countryCode,
      sourceTable: "companies",
    }));
  });
}

/**
 * Fetches at most `limit` sampled company rows for one country via
 * `/companies?country=<CODE>&has_phone=1&has_email=1&format=jsonl`.
 * `has_phone`/`has_email` are hardcoded — sampling is only useful against
 * records that already carry contact data worth deducing a mapping from.
 */
export async function fetchCountrySample(
  config: LeadsClientConfig,
  countryCode: string,
  limit: number = DEFAULT_SAMPLE_LIMIT,
): Promise<Record<string, unknown>[]> {
  const url =
    `${config.baseUrl}/${config.companiesPath}?country=${encodeURIComponent(countryCode)}` +
    `&has_phone=1&has_email=1&format=jsonl` +
    `&key=${encodeURIComponent(config.keyValue)}&limit=${limit}&offset=0`;
  const doFetch = resolveFetch(config);

  return withTimeout(config, async (signal) => {
    const response = await doFetch(url, { signal });
    if (!response.ok) {
      throw new Error(
        `Leads DB companies request failed for country ${countryCode} with status ${response.status}`,
      );
    }
    const text = await response.text();
    return parseJsonLines(text);
  });
}

/**
 * Samples every given source_catalog pair (`sourceDb` = country code). Each
 * country is fetched independently inside its own try/catch: a slow or
 * failing country is reported in its outcome's `error` field and never
 * aborts the rest of the run — this is the behavior that protects the
 * overall bootstrap run from one bad country (e.g. NI/SV returning HTTP 500).
 */
export async function sampleCountries(
  config: LeadsClientConfig,
  pairs: readonly LeadsCatalogEntry[],
  limit: number = DEFAULT_SAMPLE_LIMIT,
): Promise<TableSampleOutcome[]> {
  const outcomes: TableSampleOutcome[] = [];

  for (const pair of pairs) {
    try {
      const rows = await fetchCountrySample(config, pair.sourceDb, limit);
      outcomes.push({ sourceDb: pair.sourceDb, sourceTable: pair.sourceTable, rows });
    } catch (error) {
      outcomes.push({
        sourceDb: pair.sourceDb,
        sourceTable: pair.sourceTable,
        rows: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcomes;
}
