CREATE TABLE migration_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused','stopped','completed','failed')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
