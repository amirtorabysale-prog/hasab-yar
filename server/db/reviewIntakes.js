import { ensureReviewIntakeSchema as ensure } from '../reviewIntakeSchema.js';
import { randomUUID } from 'node:crypto';
import { activeWorkspaceDatabase, audit, currentWorkspace } from './core.js';
import { needsUnquantifiedReview, UNQUANTIFIED_REVIEW_REASON } from '../../shared/reviewIntake.js';

// An unquantified request is a case, not a financial event with a fabricated amount.

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
function describe(row) {
  return { id: row.id, intake: true, route: 'accountant-review', amount: null,
    status: row.status, transcript: row.transcript, occurredAt: row.created_at,
    resolution: row.resolution, journalEntryId: row.journal_entry_id,
    confidence: { summary: UNQUANTIFIED_REVIEW_REASON }, event: { amountUnknown: true } };
}
export function queueUnquantifiedReview(transcript, { clientId = '', source = 'text' } = {}) {
  const text = String(transcript || '').trim().slice(0, 1000);
  if (!needsUnquantifiedReview(text)) throw invalid('این مسیر فقط برای درخواست بررسی حسابداری بدون مبلغ است.');
  const database = activeWorkspaceDatabase(); ensure(database);
  const key = String(clientId || randomUUID()).slice(0, 100);
  const old = database.prepare('SELECT * FROM accountant_intakes WHERE client_id=?').get(key);
  if (old) {
    if (old.transcript !== text) throw invalid('شناسه درخواست قبلاً برای متن دیگری استفاده شده است.', 409);
    return { ...describe(old), duplicate: true };
  }
  const id = `intake-${randomUUID()}`;
  database.prepare('INSERT INTO accountant_intakes (id,client_id,transcript,source,created_by) VALUES (?,?,?,?,?)')
    .run(id, key, text, source === 'voice' ? 'voice' : 'text', currentWorkspace()?.userId || null);
  audit('create', 'accountant-intake', id, { reason: UNQUANTIFIED_REVIEW_REASON });
  return describe(database.prepare('SELECT * FROM accountant_intakes WHERE id=?').get(id));
}
export function listUnquantifiedReviews({ limit = 50 } = {}) {
  const database = activeWorkspaceDatabase(); ensure(database);
  return database.prepare("SELECT * FROM accountant_intakes WHERE status='pending' ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, Number(limit) || 50))).map(describe);
}
export function resolveUnquantifiedReview(id, { reason = '', journalEntryId = '' } = {}) {
  const database = activeWorkspaceDatabase(); ensure(database);
  const explanation = String(reason).trim().slice(0, 1000);
  if (explanation.length < 8) throw invalid('نتیجه بررسی و دلیل بستن پرونده را با حداقل هشت نویسه بنویس.');
  if (journalEntryId && !database.prepare('SELECT id FROM journal_entries WHERE id=?').get(String(journalEntryId))) throw invalid('سند ارجاع‌شده در این دفتر وجود ندارد.');
  const changed = database.prepare("UPDATE accountant_intakes SET status='resolved',resolution=?,resolved_by=?,resolved_at=CURRENT_TIMESTAMP,journal_entry_id=? WHERE id=? AND status='pending'")
    .run(explanation, currentWorkspace()?.userId || null, journalEntryId || null, id).changes;
  if (!changed) throw invalid('پرونده در انتظار بررسی پیدا نشد.', 409);
  audit('resolve', 'accountant-intake', id, { reason: explanation, journalEntryId: journalEntryId || null });
  return describe(database.prepare('SELECT * FROM accountant_intakes WHERE id=?').get(id));
}
