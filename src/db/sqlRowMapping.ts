/**
 * Converts a single snake_case identifier to camelCase, e.g. `run_id` -> `runId`.
 */
export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * Converts every key of a raw sqlite row object (snake_case, as returned by
 * better-sqlite3) into a new plain object with camelCase keys. Values are
 * copied as-is; callers that need further coercion (e.g. SQLite's 0/1
 * integers into booleans) apply it after calling this helper.
 *
 * Shared across `runsRepo.ts`, `checkpointRepo.ts`, and `importErrorRepo.ts`
 * so each repo's row-mapping logic is a single spread instead of a
 * hand-written field-by-field mapper.
 */
export function mapRowKeysToCamelCase<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value;
  }
  return result as T;
}
