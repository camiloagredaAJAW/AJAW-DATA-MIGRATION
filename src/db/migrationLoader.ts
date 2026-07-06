import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATION_FILE_PATTERN = /^(\d+)_.+\.sql$/;

/**
 * Reads every `NNN_*.sql` file in `migrationsDir`, parses its numeric
 * version prefix, and returns them sorted ascending by version.
 * Files that don't match the naming pattern are ignored.
 */
export function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  const entries = readdirSync(migrationsDir).filter((name) =>
    MIGRATION_FILE_PATTERN.test(name),
  );

  const files = entries.map((name) => {
    const match = name.match(MIGRATION_FILE_PATTERN);
    const versionText = match?.[1];
    if (!versionText) {
      throw new Error(`Migration file does not match the expected pattern: ${name}`);
    }
    const version = Number.parseInt(versionText, 10);
    const sql = readFileSync(join(migrationsDir, name), "utf-8");
    return { version, name, sql };
  });

  return files.sort((a, b) => a.version - b.version);
}
