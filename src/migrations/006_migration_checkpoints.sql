CREATE TABLE migration_checkpoints (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES migration_runs(id),
  country_code TEXT NOT NULL,
  ai_search_id INTEGER,
  last_offset INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, country_code)
);
