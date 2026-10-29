import { randomUUID } from 'node:crypto';
import {
  COUNTERPARTY_RESOLUTIONS, canonicalCounterpartyName, cleanCounterpartyDisplayName, exactCounterpartyKey,
} from '../shared/counterpartyIdentity.js';
import { partyRoleOf } from '../shared/partyRole.js';

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnExists(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addCanonicalColumn(database) {
  try { database.exec("ALTER TABLE contacts ADD COLUMN canonical_name TEXT NOT NULL DEFAULT ''"); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

/**
 * ستون هویت را پر می‌کند و هیچ ادغامی انجام نمی‌دهد.
 *
 * چرا دیگر ادغام خودکار نیست: این تابع روی هر بار باز شدن دفتر اجرا می‌شود، بی‌آنکه
 * کسی آن را ببیند. ادغام دو طرف حساب اسناد ثبت‌شده را به طرف حساب دیگری
 * می‌بندد و یکی کردنِ «مشابه»ها تصمیمی است که فقط ثبت‌کننده می‌تواند بگیرد.
 */
export function ensureCounterpartyIdentitySchema(database) {
  if (!tableExists(database, 'contacts')) return;
  addCanonicalColumn(database);
  const update = database.prepare('UPDATE contacts SET canonical_name=? WHERE id=?');
  for (const contact of database.prepare('SELECT id,name FROM contacts').all()) {
    update.run(canonicalCounterpartyName(contact.name), contact.id);
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_contacts_canonical_name ON contacts(canonical_name)');
  ensureContactRole(database);
}

/** متنی که ورود بکاپ پارسیان روی شخص ساخته‌شده می‌گذارد. */
export const PARSIAN_CONTACT_NOTE = 'ساخته‌شده از تفصیلی‌های بکاپ پارسیان';

/**
 * نقش شخص (`employee` پرسنل، `partner` شریک، خالی یعنی هیچ‌کدام) جدا از نوعش.
 *
 * نوع (مشتری/تأمین‌کننده/شخص) در فاکتور و تعهد به کار می‌رود و سه‌مقداری می‌ماند؛
 * پرسنل و شریک «شخص»اند با نقشی که کارت نشان می‌دهد. CHECK جدول contacts عوض
 * نمی‌شود، چون بازسازی آن ارجاع چهار جدول دیگر را جابه‌جا می‌کرد.
 */
function ensureContactRole(database) {
  if (columnExists(database, 'contacts', 'role')) return;
  database.exec("ALTER TABLE contacts ADD COLUMN role TEXT NOT NULL DEFAULT ''");
  repairParsianContactRoles(database);
}

/**
 * اشخاصی که ورود بکاپ پیش از این اصلاح فقط از سمت حساب نوع گرفته بودند: کارمندِ زیر
 * «حقوق پرداختنی» تأمین‌کننده شده بود. نقش از معین و کل همان تفصیلی‌ها خوانده می‌شود.
 */
export function repairParsianContactRoles(database) {
  if (!tableExists(database, 'analytic_accounts') || !tableExists(database, 'chart_accounts')) return 0;
  const analytics = database.prepare("SELECT id,name FROM analytic_accounts WHERE source_kind='contact' AND source_key=?");
  const charts = database.prepare(`SELECT DISTINCT ca.name AS chartName,parent.name AS kolName FROM journal_lines jl
    JOIN ledger_accounts la ON la.id=jl.account_id JOIN chart_accounts ca ON ca.id=la.chart_account_id
    LEFT JOIN chart_accounts parent ON parent.id=ca.parent_id WHERE jl.analytic_id=?`);
  const save = database.prepare("UPDATE contacts SET role=?,kind=CASE WHEN kind IN ('customer','vendor') THEN 'person' ELSE kind END WHERE id=?");
  let changed = 0;
  for (const contact of database.prepare("SELECT id,name FROM contacts WHERE note=? AND role=''").all(PARSIAN_CONTACT_NOTE)) {
    const own = analytics.all(contact.id);
    const role = partyRoleOf({ names: [contact.name, ...own.map((item) => item.name)], charts: own.flatMap((item) => charts.all(item.id)) });
    if (role) { save.run(role, contact.id); changed += 1; }
  }
  return changed;
}

/**
 * طرف حسابِ موجود برای یک نام.
 *
 * - `exact`: همان نوشته، با تفاوت فقط در «ي»/«ی»، نیم‌فاصله یا علامت‌ها. بی‌پرسش
 *   همان است.
 * - `similar`: فقط پس از کنار گذاشتن شکل حقوقی یکی است — «شرکت آرمان» و «آرمان».
 *   احتمالاً همان است، ولی باید پرسید.
 */
export function matchCounterparty(database, name) {
  const canonical = canonicalCounterpartyName(name);
  if (!canonical) return { exact: null, similar: null };
  const exactKey = exactCounterpartyKey(name);
  const candidates = database.prepare(`SELECT id,name,kind,phone,note FROM contacts
    WHERE canonical_name=? ORDER BY created_at,rowid`).all(canonical);
  const exact = candidates.find((item) => exactCounterpartyKey(item.name) === exactKey) || null;
  return { exact, similar: exact ? null : candidates[0] || null };
}

/**
 * خطای «این نام شبیه طرف حساب موجود است».
 *
 * خطا و نه تصمیم: سرور نمی‌داند «آرمان» همان «شرکت آرمان» است یا نه. رابط کاربری
 * این را به یک پرسش تبدیل می‌کند و همان درخواست را با پاسخ کاربر دوباره می‌فرستد.
 */
export function counterpartySimilarError(input, existing) {
  return Object.assign(new Error(`«${input}» شبیه طرف حساب «${existing.name}» است؛ همان است یا جداست؟`), {
    status: 409,
    code: 'COUNTERPARTY_SIMILAR',
    details: { input: String(input || ''), existing: { id: existing.id, name: existing.name } },
  });
}

/**
 * طرف حسابی که یک ثبت باید به آن بنشیند.
 *
 * برمی‌گرداند `{ contact }` برای طرف حساب موجود، یا `{ contact: null }` یعنی باید
 * تازه ساخته شود. اگر نام مشابهِ موجود داشت و ثبت‌کننده هنوز جواب نداده، خطای
 * پرسش پرتاب می‌شود.
 */
export function resolveCounterparty(database, name, resolution = '') {
  const { exact, similar } = matchCounterparty(database, name);
  if (exact) return { contact: exact };
  if (!similar) return { contact: null };
  if (resolution === COUNTERPARTY_RESOLUTIONS.MERGE) return { contact: similar };
  if (resolution === COUNTERPARTY_RESOLUTIONS.SEPARATE) return { contact: null };
  throw counterpartySimilarError(name, similar);
}

// ------------------------------------------------------- ادغام تأییدشده

/** کد تفصیلی نرم‌افزار مقصد؛ همان چیزی که طرف حساب را در پارسیان پیدا می‌کند. */
function analyticCode(database, analyticId) {
  if (!analyticId || !columnExists(database, 'analytic_accounts', 'external_code')) return null;
  return database.prepare('SELECT external_code AS code FROM analytic_accounts WHERE id=?').get(analyticId)?.code || null;
}

function contactAnalytic(database, contactId) {
  if (!tableExists(database, 'analytic_accounts')) return null;
  return database.prepare("SELECT id FROM analytic_accounts WHERE source_kind='contact' AND source_key=?").get(contactId) || null;
}

/**
 * ادغام دو طرف حساب، فقط وقتی کسی آن را خواسته است.
 *
 * سه قید دارد:
 * - اگر هر دو کد مقصدِ متفاوت دارند، حسابدار آن‌ها را عمداً دو تفصیلی جدا در پارسیان
 *   تعریف کرده و ادغام رد می‌شود.
 * - کدِ مقصدِ ردیف حذف‌شده به ردیف ماندگار منتقل می‌شود، وگرنه نگاشتی که حسابدار
 *   دستی ساخته بود بی‌صدا از بین می‌رفت.
 * - یا کل ادغام انجام می‌شود یا هیچ‌چیز، و در Audit Log می‌نشیند.
 */
export function mergeCounterparties(database, keeperId, duplicateId, { actor = null } = {}) {
  const keeper = database.prepare('SELECT id,name FROM contacts WHERE id=?').get(String(keeperId || ''));
  const duplicate = database.prepare('SELECT id,name FROM contacts WHERE id=?').get(String(duplicateId || ''));
  if (!keeper || !duplicate || keeper.id === duplicate.id) {
    throw Object.assign(new Error('طرف حساب‌های ادغام معتبر نیستند.'), { status: 400, code: 'COUNTERPARTY_MERGE_INVALID' });
  }
  const kept = contactAnalytic(database, keeper.id);
  const removed = contactAnalytic(database, duplicate.id);
  const keptCode = analyticCode(database, kept?.id);
  const removedCode = analyticCode(database, removed?.id);
  if (keptCode && removedCode && keptCode !== removedCode) {
    throw Object.assign(new Error('این دو طرف حساب در نرم‌افزار مقصد دو کد تفصیلی متفاوت دارند و ادغام نمی‌شوند.'), {
      status: 409, code: 'COUNTERPARTY_MERGE_CONFLICT',
    });
  }

  database.exec('SAVEPOINT counterparty_merge');
  try {
    for (const table of ['transactions', 'obligations', 'invoices']) {
      if (tableExists(database, table)) database.prepare(`UPDATE ${table} SET contact_id=? WHERE contact_id=?`).run(keeper.id, duplicate.id);
    }
    if (removed && kept) {
      if (removedCode && !keptCode) database.prepare('UPDATE analytic_accounts SET external_code=? WHERE id=?').run(removedCode, kept.id);
      if (tableExists(database, 'journal_lines')) database.prepare('UPDATE journal_lines SET analytic_id=? WHERE analytic_id=?').run(kept.id, removed.id);
      database.prepare('DELETE FROM analytic_accounts WHERE id=?').run(removed.id);
    } else if (removed) {
      database.prepare('UPDATE analytic_accounts SET source_key=?,name=? WHERE id=?').run(keeper.id, keeper.name, removed.id);
    }
    database.prepare('DELETE FROM contacts WHERE id=?').run(duplicate.id);
    if (tableExists(database, 'audit_log')) {
      database.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
        .run(randomUUID(), 'merge', 'contact', keeper.id, JSON.stringify({ kept: keeper.name, merged: duplicate.name, mergedId: duplicate.id, actor }));
    }
    database.exec('RELEASE counterparty_merge');
  } catch (error) {
    database.exec('ROLLBACK TO counterparty_merge');
    database.exec('RELEASE counterparty_merge');
    throw error;
  }
  return keeper;
}

export function normalizedCounterpartyInput(name) {
  const displayName = cleanCounterpartyDisplayName(name);
  return { displayName, canonicalName: canonicalCounterpartyName(displayName) };
}
