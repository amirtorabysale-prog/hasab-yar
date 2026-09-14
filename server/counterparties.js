import { randomUUID } from 'node:crypto';
import { canonicalCounterpartyName, cleanCounterpartyDisplayName } from '../shared/counterpartyIdentity.js';

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function addCanonicalColumn(database) {
  try { database.exec("ALTER TABLE contacts ADD COLUMN canonical_name TEXT NOT NULL DEFAULT ''"); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

function columnExists(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

/**
 * کد تفصیلیِ نرم‌افزار مقصد برای یک طرف حساب.
 *
 * این کد را حسابدار دستی گذاشته و همان چیزی است که طرف حساب را در پارسیان پیدا
 * می‌کند. ادغامی که آن را دور بریزد، طرف حساب را در فایل انتقال بی‌نام می‌کند.
 */
function analyticCode(database, analyticId) {
  if (!analyticId || !columnExists(database, 'analytic_accounts', 'external_code')) return null;
  return database.prepare('SELECT external_code AS code FROM analytic_accounts WHERE id=?').get(analyticId)?.code || null;
}

/**
 * آیا این دو را می‌شود بی‌خطر ادغام کرد؟
 *
 * اگر هر دو کد مقصدِ متفاوت دارند، حسابدار آن‌ها را عمداً دو تفصیلی جدا در
 * پارسیان تعریف کرده؛ ادغام خودکار یعنی نادیده گرفتن تصمیم او. این‌ها دست‌نخورده
 * می‌مانند تا یک انسان تصمیم بگیرد.
 */
function mergeConflict(database, keeper, duplicate) {
  if (!tableExists(database, 'analytic_accounts')) return false;
  const kept = database.prepare("SELECT id FROM analytic_accounts WHERE source_kind='contact' AND source_key=?").get(keeper.id);
  const removed = database.prepare("SELECT id FROM analytic_accounts WHERE source_kind='contact' AND source_key=?").get(duplicate.id);
  const keptCode = analyticCode(database, kept?.id);
  const removedCode = analyticCode(database, removed?.id);
  return Boolean(keptCode && removedCode && keptCode !== removedCode);
}

function mergeContact(database, keeper, duplicate) {
  for (const table of ['transactions', 'obligations', 'invoices']) {
    if (tableExists(database, table)) database.prepare(`UPDATE ${table} SET contact_id=? WHERE contact_id=?`).run(keeper.id, duplicate.id);
  }
  if (tableExists(database, 'analytic_accounts')) {
    const kept = database.prepare("SELECT id FROM analytic_accounts WHERE source_kind='contact' AND source_key=?").get(keeper.id);
    const removed = database.prepare("SELECT id FROM analytic_accounts WHERE source_kind='contact' AND source_key=?").get(duplicate.id);
    if (removed && kept) {
      // کدِ مقصدِ تکراری به نگه‌داشته منتقل می‌شود اگر آن کد نداشت؛ وگرنه با
      // حذف ردیف، نگاشتی که حسابدار دستی ساخته بود بی‌صدا از بین می‌رفت.
      const removedCode = analyticCode(database, removed.id);
      if (removedCode && !analyticCode(database, kept.id)) {
        database.prepare('UPDATE analytic_accounts SET external_code=? WHERE id=?').run(removedCode, kept.id);
      }
      if (tableExists(database, 'journal_lines')) database.prepare('UPDATE journal_lines SET analytic_id=? WHERE analytic_id=?').run(kept.id, removed.id);
      database.prepare('DELETE FROM analytic_accounts WHERE id=?').run(removed.id);
    } else if (removed) {
      database.prepare("UPDATE analytic_accounts SET source_key=?,name=? WHERE id=?").run(keeper.id, keeper.name, removed.id);
    }
  }
  database.prepare('DELETE FROM contacts WHERE id=?').run(duplicate.id);
  // ادغام، اسناد ثبت‌شده را به طرف حساب دیگری می‌بندد؛ چنین تغییری بدون ردپا
  // در زنجیرهٔ حسابرسی قابل توضیح نیست.
  if (tableExists(database, 'audit_log')) {
    database.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
      .run(randomUUID(), 'merge', 'contact', keeper.id, JSON.stringify({ kept: keeper.name, merged: duplicate.name, mergedId: duplicate.id }));
  }
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
    if (!keeper) { keepers.set(canonical, contact); continue; }
    if (mergeConflict(database, keeper, contact)) continue;
    // یا کل ادغام یک طرف حساب، یا هیچ‌چیز. ادغام نیمه‌کاره اسنادی را به
    // طرف حسابی می‌بندد که ردیفش هنوز پاک نشده، یا برعکس.
    database.exec('SAVEPOINT counterparty_merge');
    try {
      mergeContact(database, keeper, contact);
      database.exec('RELEASE counterparty_merge');
    } catch (error) {
      database.exec('ROLLBACK TO counterparty_merge');
      database.exec('RELEASE counterparty_merge');
      throw error;
    }
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
