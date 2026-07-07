import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConnection } from "../../src/db/connection.js";

describe("openConnection", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("enables foreign key enforcement", () => {
    const db = openConnection(":memory:");

    const row = db.pragma("foreign_keys", { simple: true });

    expect(row).toBe(1);
  });

  it("enables WAL journal mode for file-backed databases", () => {
    tempDir = mkdtempSync(join(tmpdir(), "mapping-bootstrap-"));
    const filePath = join(tempDir, "test.db");

    const db = openConnection(filePath);

    const journalMode = db.pragma("journal_mode", { simple: true });
    expect(journalMode).toBe("wal");

    db.close();
  });

  it("creates the parent directory when it does not exist yet", () => {
    tempDir = mkdtempSync(join(tmpdir(), "mapping-bootstrap-"));
    const filePath = join(tempDir, "nested", "data", "mapping.db");

    const db = openConnection(filePath);

    expect(db.open).toBe(true);
    db.close();
  });
});
