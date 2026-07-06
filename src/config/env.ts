/**
 * Typed, testable readers for the environment variables consumed by the
 * migration engine (Axelor connection + Leads DB pagination). Each function
 * accepts an optional env record (defaults to `process.env`) so tests never
 * need to mutate global process state.
 */

export interface AxelorConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly namespace: string;
  readonly modelNameCompanies: string;
}

export interface LeadsPageConfig {
  readonly pageLimit: number;
}

const AXELOR_REQUIRED_KEYS = [
  "AXELOR_BASE_URL",
  "AXELOR_USERNAME",
  "AXELOR_PASSWORD",
  "AJAW_NAMESPACE",
  "MODEL_NAME_COMPANIES",
] as const;

function requireEnvVar(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} must be set to run the migration engine`);
  }
  return value;
}

/**
 * Reads the Axelor connection config: base URL, Basic Auth credentials, and
 * the namespace/model name used to build fully-qualified model names for the
 * REST API (`${namespace}.${modelNameCompanies}` for AiSearchResults,
 * `${namespace}.AiSearch` for the parent).
 */
export function loadAxelorConfig(
  env: Record<string, string | undefined> = process.env,
): AxelorConfig {
  for (const key of AXELOR_REQUIRED_KEYS) {
    requireEnvVar(env, key);
  }

  return {
    baseUrl: requireEnvVar(env, "AXELOR_BASE_URL"),
    username: requireEnvVar(env, "AXELOR_USERNAME"),
    password: requireEnvVar(env, "AXELOR_PASSWORD"),
    namespace: requireEnvVar(env, "AJAW_NAMESPACE"),
    modelNameCompanies: requireEnvVar(env, "MODEL_NAME_COMPANIES"),
  };
}

/**
 * Reads the Leads DB pagination page size used by `fetchCompaniesPage`'s
 * offset loop. Must be a positive integer.
 */
export function loadLeadsPageConfig(
  env: Record<string, string | undefined> = process.env,
): LeadsPageConfig {
  const raw = requireEnvVar(env, "LEADS_DB_PAGE_LIMIT");
  const pageLimit = Number(raw);

  if (!Number.isInteger(pageLimit) || pageLimit <= 0) {
    throw new Error(`LEADS_DB_PAGE_LIMIT must be a positive integer, got "${raw}"`);
  }

  return { pageLimit };
}
