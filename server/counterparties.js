import { canonicalCounterpartyName, cleanCounterpartyDisplayName } from '../shared/counterpartyIdentity.js';

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function addCanonicalColumn(database) {
  try { database.exec("ALTER TABLE contacts ADD COLUMN canonical_name TEXT NOT NULL DEFAULT ''"); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

function mergeContact(database, keeper, duplicate) {
  for (const table of ['transactions', 'obligations', 'invoices']) {
    if (tableExists(database, table)) database.prepare(`UPDATE ${table} SET contact_id=? WHERE contact_id=?`).run(keeper.id, duplicate.id);
  }
  if (tableExists(database, 'analytic_accounts')) {
    const kept = database.prepare("SELECT id FROM analytic_accounts WHERE source_kind='contact' AND source_key=?").get(keeper.id);
    const removed = database.prepare("SELECT id FROM analytic_accounts WHERE source_kind='contact' AND source_key=?").get(duplicate.id);
    if (removed && kept) {
      if (tableExists(database, 'journal_lines')) database.prepare('UPDATE journal_lines SET analytic_id=? WHERE analytic_id=?').run(kept.id, removed.id);
      database.prepare('DELETE FROM analytic_accounts WHERE id=?').run(removed.id);
    } else if (removed) {
      database.prepare("UPDATE analytic_accounts SET source_key=?,name=? WHERE id=?").run(keeper.id, keeper.name, removed.id);
    }
  }
  database.prepare('DELETE FROM contacts WHERE id=?').run(duplicate.id);
}

/** ستون هویت را می‌سازد و تکراری‌های قطعی را همراه اسناد و تفصیلی ادغام می‌کند. */
export function ensureCounterpartyIdentitySchema(database) {
  if (!tableExists(database, 'contacts')) return;
  addCanonicalColumn(database);
  const contacts = database.prepare('SELECT id,name FROM contacts ORDER BY created_at,rowid').all();
  const keepers = new Map();
  for (const contact of contacts) {
    const canonical = canonicalCounterpartyName(contact.name);
    database.prepare('UPDATE contacts SET canonical_name=? WHERE id=?').run(canonical, contact.id);
    if (!canonical) continue;
    const keeper = keepers.get(canonical);
    if (keeper) mergeContact(database, keeper, contact);
    else keepers.set(canonical, contact);
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_contacts_canonical_name ON contacts(canonical_name)');
}

export function findCounterpartyByName(database, name) {
  const canonical = canonicalCounterpartyName(name);
  if (!canonical) return null;
  return database.prepare('SELECT id,name,kind,phone,note,canonical_name AS canonicalName FROM contacts WHERE canonical_name=? ORDER BY created_at,rowid LIMIT 1').get(canonical) || null;
}

export function normalizedCounterpartyInput(name) {
  const displayName = cleanCounterpartyDisplayName(name);
  return { displayName, canonicalName: canonicalCounterpartyName(displayName) };
}
