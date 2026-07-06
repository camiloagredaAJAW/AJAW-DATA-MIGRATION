CREATE TABLE field_mappings (
  id INTEGER PRIMARY KEY,
  source_db TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_column TEXT NOT NULL,
  destination_domain TEXT NOT NULL CHECK(destination_domain IN ('AiSearchResults')),
  destination_field TEXT,
  additional_info_key TEXT,
  transform TEXT REFERENCES sanitization_rules(name),
  confidence TEXT CHECK(confidence IN ('high','medium','low')),
  note TEXT,
  origin TEXT NOT NULL DEFAULT 'bootstrap' CHECK(origin IN ('seed','bootstrap','admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_db, source_table, source_column)
);
