CREATE INDEX IF NOT EXISTS idx_migration_checkpoints_country_code ON migration_checkpoints(country_code);
CREATE INDEX IF NOT EXISTS idx_import_errors_resolved ON import_errors(resolved);
