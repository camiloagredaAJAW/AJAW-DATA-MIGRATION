CREATE TABLE migration_checkpoints_new (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES migration_runs(id),
  country_code TEXT NOT NULL,
  ai_search_id INTEGER,
  last_offset INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','halted','completed','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, country_code)
);

INSERT INTO migration_checkpoints_new (id, run_id, country_code, ai_search_id, last_offset, status, created_at, updated_at)
SELECT id, run_id, country_code, ai_search_id, last_offset,
       CASE status WHEN 'in_progress' THEN 'halted' ELSE status END,
       created_at, updated_at
FROM migration_checkpoints;

DROP TABLE migration_checkpoints;
ALTER TABLE migration_checkpoints_new RENAME TO migration_checkpoints;

CREATE INDEX IF NOT EXISTS idx_migration_checkpoints_country_code ON migration_checkpoints(country_code);
