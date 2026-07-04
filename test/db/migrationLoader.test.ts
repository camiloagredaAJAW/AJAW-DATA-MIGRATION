import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrationFiles } from "../../src/db/migrationLoader.js";

describe("loadMigrationFiles", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("sorts migration files numerically by their version prefix, not alphabetically", () => {
    tempDir = mkdtempSync(join(tmpdir(), "migration-loader-"));
    writeFileSync(join(tempDir, "010_ten.sql"), "SELECT 10;");
    writeFileSync(join(tempDir, "002_two.sql"), "SELECT 2;");
    writeFileSync(join(tempDir, "001_one.sql"), "SELECT 1;");

    const files = loadMigrationFiles(tempDir);

    expect(files.map((file) => file.version)).toEqual([1, 2, 10]);
    expect(files.map((file) => file.name)).toEqual([
      "001_one.sql",
      "002_two.sql",
      "010_ten.sql",
    ]);
  });

  it("ignores files that do not match the NNN_*.sql naming pattern", () => {
    tempDir = mkdtempSync(join(tmpdir(), "migration-loader-"));
    writeFileSync(join(tempDir, "001_valid.sql"), "SELECT 1;");
    writeFileSync(join(tempDir, "README.md"), "not a migration");
    writeFileSync(join(tempDir, "seed.sql"), "SELECT 0;");

    const files = loadMigrationFiles(tempDir);

    expect(files.map((file) => file.name)).toEqual(["001_valid.sql"]);
    expect(files[0]?.sql).toBe("SELECT 1;");
  });
});
