import { randomUUID } from 'node:crypto';
import { activeWorkspaceDatabase, audit, canonicalRequestBody, currentWorkspace, invalidInput } from './core.js';
import { listWorkspaceMembers } from './workspaces.js';
import { OVERDRAFT_APPROVER_ROLES, ensureOverdraftSchema } from '../balanceGuard.js';

/**
 * صف تأیید دونفره.
 *
 * وقتی دفتر جز ثبت‌کننده حسابدار یا مدیر دیگری دارد، کسی که پول را از صندوق
 * برمی‌دارد نمی‌تواند خودش منفی شدنش را تأیید کند؛ همین برای کالایی که بیش از
 * موجودی فروخته می‌شود و سندی که به پارسیان رفته. درخواست با همان مسیر و
 * بدنه‌ای که رد شد این‌جا می‌ماند، نفر دوم با دلیل تأیید می‌کند، و همان درخواست
 * — نه چیز دیگری — یک بار اجرا می‌شود.
 */

const KINDS = new Set(['cash', 'stock', 'export']);
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const database = () => {
  const active = activeWorkspaceDatabase();
  ensureOverdraftSchema(active);
  return active;
};

/** آیا کسی جز این کاربر در دفتر هست که بتواند تأیید کند؟ */
export function otherApproverExists(workspaceId, userId) {
  return listWorkspaceMembers(workspaceId).some((member) => member.id !== userId && OVERDRAFT_APPROVER_ROLES.includes(member.role));
}

/** «inline»: خودش با دلیل تأیید می‌کند؛ «request»: باید برای نفر دوم بفرستد. */
export function approvalModeFor(workspaceId, userId, role) {
  if (!OVERDRAFT_APPROVER_ROLES.includes(role)) return 'request';
  return otherApproverExists(workspaceId, userId) ? 'request' : 'inline';
}

function hydrate(row) {
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
  return {
    id: row.id, kind: row.kind, method: row.method, path: row.path, body: row.body ? JSON.parse(row.body) : null,
    message: row.message, items, note: row.note, status: row.status, requestedBy: row.requested_by,
    decidedBy: row.decided_by, deciderRole: row.decider_role, decisionReason: row.decision_reason,
    decidedAt: row.decided_at, executedBy: row.executed_by, executedAt: row.executed_at, createdAt: row.created_at,
  };
}

export function createApprovalRequest(values = {}) {
  const actor = currentWorkspace() || {};
  const kind = KINDS.has(values.kind) ? values.kind : 'cash';
  const method = String(values.method || '').toUpperCase();
  const path = String(values.path || '').split('?')[0];
  if (!METHODS.has(method)) throw invalidInput('نوع درخواست قابل تأیید نیست.');
  if (!/^\/api\/[\w\-/.%]+$/.test(path) || path.startsWith('/api/approval-requests')) throw invalidInput('مسیر درخواست قابل تأیید نیست.');
  let body;
  try { body = canonicalRequestBody(values.body ?? null); } catch { throw invalidInput('بدنهٔ درخواست معتبر نیست.'); }
  if (body.length > 200_000) throw invalidInput('درخواست بزرگ‌تر از آن است که در صف بماند.');
  const id = randomUUID();
  database().prepare(`INSERT INTO approval_requests (id,kind,method,path,body,message,items,note,requested_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, kind, method, path, body, String(values.message || '').slice(0, 1000),
    JSON.stringify(Array.isArray(values.items) ? values.items.slice(0, 20) : []), String(values.note || '').trim().slice(0, 300),
    actor.userId || null);
  audit('request', 'approval_request', id, { kind, method, path });
  return getApprovalRequest(id);
}

export function getApprovalRequest(id) {
  return hydrate(database().prepare('SELECT * FROM approval_requests WHERE id=?').get(String(id || '')));
}

export function listApprovalRequests({ status = 'open' } = {}) {
  const where = status === 'all' ? '' : status === 'open' ? "WHERE status IN ('pending','approved')" : 'WHERE status=?';
  const params = status === 'all' || status === 'open' ? [] : [String(status)];
  return database().prepare(`SELECT * FROM approval_requests ${where} ORDER BY created_at DESC,rowid DESC LIMIT 100`).all(...params).map(hydrate);
}

/**
 * تصمیم نفر دوم. ثبت‌کننده تصمیمِ درخواست خودش را نمی‌گیرد، مگر دفتر
 * تأییدکنندهٔ دیگری نداشته باشد (مثلاً حسابدار رفته و فقط مالک مانده).
 */
export function decideApprovalRequest(id, { decision, reason = '' } = {}) {
  const actor = currentWorkspace() || {};
  if (!OVERDRAFT_APPROVER_ROLES.includes(actor.role)) throw Object.assign(new Error('فقط حسابدار، مدیر یا مالک دفتر می‌تواند تأیید کند.'), { status: 403, code: 'APPROVAL_ROLE_REQUIRED' });
  const current = getApprovalRequest(id);
  if (!current) throw Object.assign(new Error('درخواست پیدا نشد.'), { status: 404, code: 'APPROVAL_REQUEST_NOT_FOUND' });
  if (current.status !== 'pending') throw Object.assign(new Error('این درخواست قبلاً تصمیم گرفته شده است.'), { status: 409, code: 'APPROVAL_REQUEST_DECIDED' });
  if (current.requestedBy && current.requestedBy === actor.userId && otherApproverExists(actor.id, actor.userId)) {
    throw Object.assign(new Error('ثبت‌کننده نمی‌تواند درخواست خودش را تأیید کند؛ نفر دوم (حسابدار یا مدیر) باید تصمیم بگیرد.'), { status: 403, code: 'APPROVAL_SELF_FORBIDDEN' });
  }
  const cleanReason = String(reason || '').trim().slice(0, 300);
  const approve = decision === 'approve';
  if (approve && cleanReason.length < 3) throw invalidInput('دلیل تأیید را بنویس تا با سند بماند.');
  database().prepare(`UPDATE approval_requests SET status=?,decided_by=?,decider_role=?,decision_reason=?,decided_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending'`).run(approve ? 'approved' : 'rejected', actor.userId || null, actor.role, cleanReason, current.id);
  audit(approve ? 'approve' : 'reject', 'approval_request', current.id, { reason: cleanReason || undefined });
  return getApprovalRequest(current.id);
}

export function cancelApprovalRequest(id) {
  const actor = currentWorkspace() || {};
  const current = getApprovalRequest(id);
  if (!current) throw Object.assign(new Error('درخواست پیدا نشد.'), { status: 404, code: 'APPROVAL_REQUEST_NOT_FOUND' });
  if (current.requestedBy !== actor.userId && !OVERDRAFT_APPROVER_ROLES.includes(actor.role)) throw Object.assign(new Error('فقط درخواست‌دهنده یا تأییدکننده می‌تواند درخواست را لغو کند.'), { status: 403 });
  database().prepare("UPDATE approval_requests SET status='cancelled' WHERE id=? AND status IN ('pending','approved')").run(current.id);
  return getApprovalRequest(current.id);
}
