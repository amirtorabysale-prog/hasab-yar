import { randomUUID } from 'node:crypto';
import { activeWorkspaceDatabase, audit, controlDb, currentTimeZone, currentWorkspace, parseStoredJson } from './core.js';
import { createJournalBatch, ensureAccountingSchema, journalWorklist, listJournal, setJournalApproval, validateLines } from '../accounting.js';
import { listWorkspaceMembers } from './workspaces.js';
import { normalizeTemplateLines } from '../journalWorkflow.js';
import { roleAllows } from '../access.js';

// ---------------------------------------------------------------------------
// فاز ۳ — ثبت انبوه، کارتابل تأیید و الگوی سند
// ---------------------------------------------------------------------------

/** نام نمایشی کاربر برای «ثبت‌کنندهٔ سند»؛ شناسهٔ خام در دفتر اسناد جایی ندارد. */
function actorName(id) {
  if (!id) return null;
  const row = controlDb.prepare('SELECT display_name,username FROM users WHERE id=?').get(id);
  return row?.display_name || row?.username || id;
}

const journalActorNames = (item) => ({
  ...item,
  createdByName: actorName(item.createdBy),
  submittedByName: actorName(item.submittedBy),
  reviewedByName: actorName(item.reviewedBy),
});

/**
 * فهرست اسناد برای دفتر اسناد — همان `listJournal` با نام ثبت‌کننده و بررسی‌کننده.
 * خواستهٔ مالک محصول: «ساعت و دقیقه باید ذکر بشه؛ ثبت‌کننده باید ذکر بشه» —
 * زمان خام (`createdAt`) از سرور می‌آید و نمایش ساعت:دقیقه کار فرانت‌اند است.
 */
export function journalOverview(query = {}) {
  const result = listJournal(activeWorkspaceDatabase(), query);
  return { ...result, items: result.items.map(journalActorNames) };
}

export function journalWorklistOverview(query = {}) {
  const workspace = currentWorkspace();
  const worklist = journalWorklist(activeWorkspaceDatabase(), {
    userId: workspace?.userId || '', limit: query.limit,
  });
  // کارتابل باید از قبل بگوید تأیید سند خودت مجاز است یا نه؛ فهمیدنش با خطای ۴۰۳ دیر است.
  return { ...worklist, checkers: workspaceCheckerAvailability(workspace?.id || 'primary', workspace?.userId || null) };
}

/**
 * تفکیک ثبت‌کننده از کنترل‌کننده فقط وقتی معنا دارد که کنترل‌کنندهٔ دیگری وجود داشته باشد.
 * دفتر یک‌نفره اگر نتواند سند خودش را تأیید کند، سندش برای همیشه در «منتظر کنترل»
 * می‌ماند: نه به تراز می‌آید و نه خروجی می‌گیرد. پس تنها در نبود کنترل‌کنندهٔ دوم،
 * خودتأییدی باز می‌شود و صریح در Audit Log ثبت می‌شود.
 */
export function workspaceCheckerAvailability(workspaceId, userId) {
  const checkers = listWorkspaceMembers(workspaceId).filter((member) => roleAllows(member.role, 'manager'));
  const others = checkers.filter((member) => member.id !== userId);
  return { checkerCount: checkers.length, otherCheckerCount: others.length, soloChecker: others.length === 0 };
}

export function submitJournalApproval(entryId, nextState, reason = '') {
  const workspace = currentWorkspace();
  const availability = workspaceCheckerAvailability(workspace?.id || 'primary', workspace?.userId || null);
  const result = setJournalApproval(activeWorkspaceDatabase(), entryId, nextState, {
    userId: workspace?.userId || null, reason, timeZone: currentTimeZone(),
    allowSelfApproval: availability.soloChecker,
  });
  audit('approval', 'journal_entry', entryId, {
    from: result.from, to: result.to, reason: reason || undefined,
    selfApproved: result.selfApproved || undefined,
    selfApprovalGround: result.selfApproved ? 'دفتر کنترل‌کنندهٔ دیگری ندارد' : undefined,
  });
  return result;
}

export function createJournalDocuments(documents = []) {
  const result = createJournalBatch(activeWorkspaceDatabase(), documents, {
    createdBy: currentWorkspace()?.userId || null,
    timeZone: currentTimeZone(),
  });
  audit('create-batch', 'journal_entry', result.entryIds[0] || 'batch', {
    created: result.created, documentNumbers: result.documentNumbers,
  });
  return result;
}

export function listJournalTemplates() {
  const database = activeWorkspaceDatabase();
  ensureAccountingSchema(database);
  return database.prepare(`SELECT id,name,memo,lines,created_at AS createdAt,updated_at AS updatedAt
    FROM journal_templates ORDER BY name`).all()
    .map((item) => ({ ...item, lines: parseStoredJson(item.lines, []) }));
}

export function saveJournalTemplate(values = {}) {
  const database = activeWorkspaceDatabase();
  ensureAccountingSchema(database);
  const name = String(values.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (name.length < 2) throw Object.assign(new Error('نام الگو باید حداقل دو نویسه باشد.'), { status: 400 });
  const lines = normalizeTemplateLines(values.lines);
  for (const line of lines) {
    if (!database.prepare('SELECT 1 FROM ledger_accounts WHERE id=? AND active=1').get(line.accountId)) {
      throw Object.assign(new Error('یکی از حساب‌های الگو معتبر یا فعال نیست.'), { status: 400, code: 'LEDGER_ACCOUNT_MISSING' });
    }
  }
  const existing = values.id
    ? database.prepare('SELECT id FROM journal_templates WHERE id=?').get(values.id)
    : database.prepare('SELECT id FROM journal_templates WHERE name=?').get(name);
  const id = existing?.id || randomUUID();
  database.prepare(`INSERT INTO journal_templates (id,name,memo,lines,created_by) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,memo=excluded.memo,lines=excluded.lines,updated_at=CURRENT_TIMESTAMP`)
    .run(id, name, String(values.memo || '').slice(0, 300), JSON.stringify(lines), currentWorkspace()?.userId || null);
  audit('save', 'journal_template', id, { name, lineCount: lines.length });
  return listJournalTemplates().find((item) => item.id === id);
}

export function deleteJournalTemplate(id) {
  const database = activeWorkspaceDatabase();
  ensureAccountingSchema(database);
  const result = database.prepare('DELETE FROM journal_templates WHERE id=?').run(String(id || ''));
  if (result.changes) audit('delete', 'journal_template', id, {});
  return Boolean(result.changes);
}

const importedTableExists = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='parsian_imported_entries'").get());

/** هر ورود بکاپ پارسیان با تعداد سندهای قطعی و غیرقطعی‌اش. */
export function importedEntriesOverview() {
  const db = activeWorkspaceDatabase();
  if (!importedTableExists(db)) return { imports: [] };
  const hasLog = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='parsian_import_log'").get());
  const imports = db.prepare(`SELECT pie.file_sha256 AS fileSha256,COUNT(*) AS total,
      SUM(CASE WHEN je.approval_state='approved' THEN 1 ELSE 0 END) AS approved,
      MIN(je.occurred_at) AS firstAt,MAX(je.occurred_at) AS lastAt
    FROM parsian_imported_entries pie JOIN journal_entries je ON je.id=pie.entry_id
    GROUP BY pie.file_sha256 ORDER BY MAX(je.created_at) DESC`).all().map((row) => ({
    ...row, total: Number(row.total), approved: Number(row.approved), pending: Number(row.total) - Number(row.approved),
    fileName: hasLog ? db.prepare("SELECT file_name AS name FROM parsian_import_log WHERE file_sha256=? AND status='imported' ORDER BY imported_at DESC LIMIT 1").get(row.fileSha256)?.name || '' : '',
  }));
  return { imports };
}

/**
 * تأیید یک‌جای سندهای یک ورود بکاپ پارسیان.
 *
 * این سندها در خود پارسیان قطعی بوده‌اند و بازبینیِ یکی‌یکیِ ۱۵۲ سند کار تکراری است
 * (دفتر «آزمون بکاپ ریالی»، ۵ آبان ۱۴۰۵). میان‌بُری در کار نیست: هر سند از همان
 * `setJournalApproval` می‌گذرد — ارسال، بعد تأیید — با همان قاعدهٔ خودتأییدی و دورهٔ باز،
 * و پیش از آن دوباره متوازن‌بودن و حساب‌هایش سنجیده می‌شود. سندی که نگذرد پیش‌نویس
 * می‌ماند و دلیلش برمی‌گردد؛ هر سند جدا (SAVEPOINT)، تا خطای یکی بقیه را نگه ندارد و
 * نیمه‌تأییدی هم نماند.
 */
export function approveImportedEntries({ fileSha256 } = {}) {
  const db = activeWorkspaceDatabase();
  const sha = String(fileSha256 || '').trim();
  if (!sha) throw Object.assign(new Error('ورود بکاپ مشخص نیست.'), { code: 'IMPORT_REQUIRED', status: 400 });
  if (!importedTableExists(db)) return { approved: 0, skipped: [] };
  const workspace = currentWorkspace();
  const availability = workspaceCheckerAvailability(workspace?.id || 'primary', workspace?.userId || null);
  const options = { userId: workspace?.userId || null, timeZone: currentTimeZone(), allowSelfApproval: availability.soloChecker };
  const entries = db.prepare(`SELECT je.id,je.approval_state AS state,je.document_number AS documentNumber,pie.sanad
    FROM parsian_imported_entries pie JOIN journal_entries je ON je.id=pie.entry_id
    WHERE pie.file_sha256=? AND je.approval_state<>'approved' ORDER BY je.occurred_at,je.document_number`).all(sha);
  const lineQuery = db.prepare('SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=?');
  let approved = 0;
  let selfApproved = 0;
  const skipped = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of entries) {
      db.exec('SAVEPOINT bulk_entry');
      try {
        validateLines(db, lineQuery.all(entry.id));
        if (entry.state !== 'submitted') setJournalApproval(db, entry.id, 'submitted', options);
        const result = setJournalApproval(db, entry.id, 'approved', options);
        if (result.selfApproved) selfApproved += 1;
        approved += 1;
        db.exec('RELEASE bulk_entry');
      } catch (error) {
        db.exec('ROLLBACK TO bulk_entry');
        db.exec('RELEASE bulk_entry');
        skipped.push({ entryId: entry.id, documentNumber: entry.documentNumber, sanad: entry.sanad, reason: error.message });
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit('bulk-approval', 'parsian_import', sha, {
    approved, skipped: skipped.length, selfApproved: selfApproved || undefined,
    selfApprovalGround: selfApproved ? 'دفتر کنترل‌کنندهٔ دیگری ندارد' : undefined,
  });
  return { approved, skipped, selfApproved };
}
