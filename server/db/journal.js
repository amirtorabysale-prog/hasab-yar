import { randomUUID } from 'node:crypto';
import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace, parseStoredJson } from './core.js';
import { createJournalBatch, ensureAccountingSchema, journalWorklist, setJournalApproval } from '../accounting.js';
import { listWorkspaceMembers } from './workspaces.js';
import { normalizeTemplateLines } from '../journalWorkflow.js';
import { roleAllows } from '../access.js';

// ---------------------------------------------------------------------------
// فاز ۳ — ثبت انبوه، کارتابل تأیید و الگوی سند
// ---------------------------------------------------------------------------

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
