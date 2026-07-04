CREATE TABLE sanitization_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('regex','code')),
  pattern TEXT,
  replacement TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);
