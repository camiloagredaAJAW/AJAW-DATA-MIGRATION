import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opens a better-sqlite3 connection configured for the mapping registry.
 * Foreign key enforcement is always enabled. WAL journaling is enabled for
 * file-backed databases only — in-memory databases do not support WAL and
 * already default to the fastest applicable journal mode.
 */
export function openConnection(filename: string): Database.Database {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }

  const db = new Database(filename);
  db.pragma("foreign_keys = ON");

  if (filename !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }

  return db;
}
