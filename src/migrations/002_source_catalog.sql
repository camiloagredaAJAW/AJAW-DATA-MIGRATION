CREATE TABLE source_catalog (
  id INTEGER PRIMARY KEY,
  source_db TEXT NOT NULL,
  source_table TEXT NOT NULL,
  country_code TEXT,
  last_sampled_at TEXT,
  sampled_row_count INTEGER,
  UNIQUE(source_db, source_table)
);
