import { parseJsonLines } from "./parseJsonLines.js";

export interface LeadsClientConfig {
  readonly baseUrl: string;
  readonly dbsPath: string;
  readonly exportPath: string;
  readonly keyValue: string;
  /** Per-request timeout in ms. Defaults to 60s — brazil_cnpj/contacts has been observed to take up to ~45s. */
  readonly timeoutMs?: number;
  /** Injectable fetch implementation, defaults to the global fetch. Lets tests avoid touching the real network. */
  readonly fetchImpl?: typeof fetch;
}

export interface LeadsCatalogEntry {
  readonly sourceDb: string;
  readonly sourceTable: string;
}

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

/** Fetches the Leads DB catalog (`/dbs`) and flattens it into source_db/source_table pairs. */
export async function fetchCatalog(config: LeadsClientConfig): Promise<LeadsCatalogEntry[]> {
  const url = `${config.baseUrl}/${config.dbsPath}?key=${encodeURIComponent(config.keyValue)}`;
  const doFetch = resolveFetch(config);

  return withTimeout(config, async (signal) => {
    const response = await doFetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Leads DB catalog request failed with status ${response.status}`);
    }
    const body = (await response.json()) as { databases?: Record<string, string[]> };
    const entries: LeadsCatalogEntry[] = [];
    for (const [sourceDb, tables] of Object.entries(body.databases ?? {})) {
      for (const sourceTable of tables) {
        entries.push({ sourceDb, sourceTable });
      }
    }
    return entries;
  });
}

/** Fetches at most `limit` sampled rows for one source_db/source_table via `/export?...&format=jsonl`. */
export async function fetchTableSample(
  config: LeadsClientConfig,
  sourceDb: string,
  sourceTable: string,
  limit: number = DEFAULT_SAMPLE_LIMIT,
): Promise<Record<string, unknown>[]> {
  const url =
    `${config.baseUrl}/${config.exportPath}?db=${encodeURIComponent(sourceDb)}` +
    `&table=${encodeURIComponent(sourceTable)}&format=jsonl` +
    `&key=${encodeURIComponent(config.keyValue)}&limit=${limit}&offset=0`;
  const doFetch = resolveFetch(config);

  return withTimeout(config, async (signal) => {
    const response = await doFetch(url, { signal });
    if (!response.ok) {
      throw new Error(
        `Leads DB export request failed for ${sourceDb}/${sourceTable} with status ${response.status}`,
      );
    }
    const text = await response.text();
    return parseJsonLines(text);
  });
}

/**
 * Samples every given source_db/source_table pair. Each table is fetched
 * independently inside its own try/catch: a slow or failing table is
 * reported in its outcome's `error` field and never aborts the rest of the
 * run — this is the behavior that protects the overall bootstrap run from
 * one bad table (e.g. brazil_cnpj/contacts timing out).
 */
export async function sampleTables(
  config: LeadsClientConfig,
  pairs: readonly LeadsCatalogEntry[],
  limit: number = DEFAULT_SAMPLE_LIMIT,
): Promise<TableSampleOutcome[]> {
  const outcomes: TableSampleOutcome[] = [];

  for (const pair of pairs) {
    try {
      const rows = await fetchTableSample(config, pair.sourceDb, pair.sourceTable, limit);
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
