export function ensureReviewIntakeSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS accountant_intakes (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, transcript TEXT NOT NULL,
    source TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
    resolution TEXT, resolved_by TEXT, resolved_at TEXT, journal_entry_id TEXT
  )`);
}
