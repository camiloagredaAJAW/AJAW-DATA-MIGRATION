CREATE TABLE import_errors (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES migration_runs(id),
  country_code TEXT NOT NULL,
  record_offset INTEGER,
  record_identifier TEXT,
  error_reason TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
  created_at TEXT NOT NULL
);
