const QUEUE_KEY = 'hesab-yar-transaction-queue';
const CSRF_KEY = 'hesab-yar-csrf';
const WORKSPACE_KEY = 'hesab-yar-workspace';

function currentWorkspaceId() {
  try { return localStorage.getItem(WORKSPACE_KEY) || ''; }
  catch { return ''; }
}

function queueKey() {
  return `${QUEUE_KEY}:${currentWorkspaceId() || 'primary'}`;
}

function currentCsrfToken() {
  try { return sessionStorage.getItem(CSRF_KEY) || ''; }
  catch { return ''; }
}

function rememberCsrfToken(token) {
  try {
    if (token) sessionStorage.setItem(CSRF_KEY, token);
    else sessionStorage.removeItem(CSRF_KEY);
  } catch { /* storage can be unavailable in hardened browser modes */ }
}

function protectedHeaders(mutating = false, extra = {}) {
  return {
    ...(mutating && currentCsrfToken() ? { 'X-CSRF-Token': currentCsrfToken() } : {}),
    ...(currentWorkspaceId() ? { 'X-Workspace-Id': currentWorkspaceId() } : {}),
    ...extra,
  };
}

async function request(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const csrfToken = currentCsrfToken();
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(mutating && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(currentWorkspaceId() ? { 'X-Workspace-Id': currentWorkspaceId() } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (body.csrfToken) rememberCsrfToken(body.csrfToken);
  const selectedWorkspace = body.workspace || body.access?.workspace;
  if (selectedWorkspace?.id) {
    try { localStorage.setItem(WORKSPACE_KEY, selectedWorkspace.id); } catch { /* private mode */ }
  }
  if (response.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/password') {
    rememberCsrfToken('');
    window.dispatchEvent(new CustomEvent('hesabyar:auth-required'));
  }
  if (response.status === 403 && body.code === 'CSRF_INVALID') rememberCsrfToken('');
  if (!response.ok) throw Object.assign(new Error(body.message || 'خطا در ارتباط با سرور'), { status: response.status, code: body.code });
  return body;
}

export const api = {
  activeWorkspaceId: currentWorkspaceId,
  selectWorkspace: (workspaceId) => {
    if (workspaceId) localStorage.setItem(WORKSPACE_KEY, workspaceId);
    else localStorage.removeItem(WORKSPACE_KEY);
  },
  workspacePath: (path) => {
    const id = currentWorkspaceId();
    if (!id) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}workspace=${encodeURIComponent(id)}`;
  },
  authStatus: () => request('/api/auth/status'),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) => request('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  workspaces: () => request('/api/workspaces'),
  createWorkspace: (payload) => request('/api/workspaces', { method: 'POST', body: JSON.stringify(payload) }),
  members: () => request('/api/workspace/members'),
  addMember: (payload) => request('/api/workspace/members', { method: 'POST', body: JSON.stringify(payload) }),
  updateMember: (userId, role) => request(`/api/workspace/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  removeMember: (userId) => request(`/api/workspace/members/${userId}`, { method: 'DELETE' }),
  bootstrap: () => request('/api/bootstrap'),
  parseText: (text, { signal } = {}) => request('/api/parse/text', { method: 'POST', body: JSON.stringify({ text }), signal }),
  parseAudio: (blob, { signal, hint } = {}) => {
    const form = new FormData();
    const extension = blob.type === 'audio/wav' ? 'wav' : 'webm';
    form.append('audio', blob, `voice.${extension}`);
    if (hint) form.append('hint', String(hint).slice(0, 500));
    return request('/api/parse/audio', { method: 'POST', body: form, signal });
  },
  saveTransactions: (payload) => request('/api/transactions', { method: 'POST', body: JSON.stringify(payload) }),
  transactions: (params = {}) => request(`/api/transactions?${new URLSearchParams(params)}`),
  updateTransaction: (id, payload) => request(`/api/transactions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteTransaction: (id) => request(`/api/transactions/${id}`, { method: 'DELETE' }),
  report: (range) => request(`/api/reports?range=${range}`),
  overview: () => request('/api/overview'),
  accountingAccounts: () => request('/api/accounting/accounts'),
  trialBalance: (through = '') => request(`/api/accounting/trial-balance${through ? `?through=${encodeURIComponent(through)}` : ''}`),
  journal: (params = {}) => request(`/api/accounting/journal?${new URLSearchParams(params)}`),
  createAdjustingJournal: (payload) => request('/api/accounting/journal', { method: 'POST', body: JSON.stringify(payload) }),
  accountingPeriods: () => request('/api/accounting/periods'),
  lockAccountingPeriod: (period) => request(`/api/accounting/periods/${encodeURIComponent(period)}/lock`, { method: 'POST', body: '{}' }),
  reopenAccountingPeriod: (period, reason) => request(`/api/accounting/periods/${encodeURIComponent(period)}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) }),
  taxRates: () => request('/api/tax/rates'),
  saveTaxRate: (payload) => request(payload.id ? `/api/tax/rates/${payload.id}` : '/api/tax/rates', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  taxReport: (from, to) => request(`/api/tax/report?${new URLSearchParams({ from, to })}`),
  accounts: () => request('/api/accounts'),
  saveAccount: (payload) => request(payload.id ? `/api/accounts/${payload.id}` : '/api/accounts', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  contacts: () => request('/api/contacts'),
  saveContact: (payload) => request(payload.id ? `/api/contacts/${payload.id}` : '/api/contacts', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  deleteContact: (id) => request(`/api/contacts/${id}`, { method: 'DELETE' }),
  obligations: (status = 'open') => request(`/api/obligations?status=${encodeURIComponent(status)}`),
  saveObligation: (payload) => request(payload.id ? `/api/obligations/${payload.id}` : '/api/obligations', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  settleObligation: (id) => request(`/api/obligations/${id}/settle`, { method: 'POST', body: '{}' }),
  deleteObligation: (id) => request(`/api/obligations/${id}`, { method: 'DELETE' }),
  recurring: () => request('/api/recurring'),
  saveRecurring: (payload) => request('/api/recurring', { method: 'POST', body: JSON.stringify(payload) }),
  deleteRecurring: (id) => request(`/api/recurring/${id}`, { method: 'DELETE' }),
  invoices: (params = {}) => request(`/api/invoices?${new URLSearchParams(params)}`),
  invoice: (id) => request(`/api/invoices/${id}`),
  saveInvoice: (payload) => request('/api/invoices', { method: 'POST', body: JSON.stringify(payload) }),
  issueInvoice: (id, payload = {}) => request(`/api/invoices/${id}/issue`, { method: 'POST', body: JSON.stringify(payload) }),
  recordInvoicePayment: (id, payload) => request(`/api/invoices/${id}/payments`, { method: 'POST', body: JSON.stringify(payload) }),
  markInvoicePaid: (id) => request(`/api/invoices/${id}/paid`, { method: 'POST', body: '{}' }),
  deleteInvoice: (id) => request(`/api/invoices/${id}`, { method: 'DELETE' }),
  reconciliationImports: () => request('/api/reconciliation/imports'),
  reconciliationImport: (id) => request(`/api/reconciliation/imports/${id}`),
  importBankStatement: (file, accountId) => { const form = new FormData(); form.append('statement', file); form.append('accountId', accountId); return request('/api/reconciliation/imports', { method: 'POST', body: form }); },
  matchReconciliationLine: (id, transactionId) => request(`/api/reconciliation/lines/${id}/match`, { method: 'POST', body: JSON.stringify({ transactionId }) }),
  createFromReconciliationLine: (id, category) => request(`/api/reconciliation/lines/${id}/create`, { method: 'POST', body: JSON.stringify({ category }) }),
  ignoreReconciliationLine: (id, reason) => request(`/api/reconciliation/lines/${id}/ignore`, { method: 'POST', body: JSON.stringify({ reason }) }),
  closeReconciliation: (id) => request(`/api/reconciliation/imports/${id}/close`, { method: 'POST', body: '{}' }),
  closings: () => request('/api/closings'),
  closeDay: (payload) => request('/api/closings', { method: 'POST', body: JSON.stringify(payload) }),
  receipts: () => request('/api/receipts'),
  saveReceipt: (image, note = '') => { const form = new FormData(); form.append('image', image); form.append('note', note); return request('/api/receipts', { method: 'POST', body: form }); },
  deleteReceipt: (id) => request(`/api/receipts/${id}`, { method: 'DELETE' }),
  products: () => request('/api/products'),
  inventoryOverview: () => request('/api/inventory/overview'),
  saveProduct: (payload) => request(payload.id ? `/api/products/${payload.id}` : '/api/products', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  adjustStock: (id, quantity, note = '', unitCost = null) => request(`/api/products/${id}/stock`, { method: 'POST', body: JSON.stringify({ quantity, note, unitCost }) }),
  ask: (question) => request('/api/ask', { method: 'POST', body: JSON.stringify({ question }) }),
  voiceStats: () => request('/api/voice/stats'),
  learnings: () => request('/api/learnings'),
  saveLearning: (payload) => request('/api/learnings', { method: 'POST', body: JSON.stringify(payload) }),
  updateLearning: (id, payload) => request(`/api/learnings/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteLearning: (id) => request(`/api/learnings/${id}`, { method: 'DELETE' }),
  settings: (payload) => request('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  backupStatus: () => request('/api/backups/status'),
  createServerSnapshot: () => request('/api/backups/snapshot', { method: 'POST', body: '{}' }),
  downloadBackup: async (passphrase) => {
    const response = await fetch('/api/backups/export', {
      method: 'POST', credentials: 'same-origin',
      headers: protectedHeaders(true, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ passphrase }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.message || 'ساخت پشتیبان انجام نشد.'), { status: response.status, code: body.code });
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `hesab-yar-${new Date().toISOString().slice(0, 10)}.hybackup`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { fileName, bytes: blob.size };
  },
  previewBackup: (file, passphrase) => {
    const form = new FormData(); form.append('backup', file); form.append('passphrase', passphrase);
    return request('/api/backups/preview', { method: 'POST', body: form });
  },
  restoreBackup: (file, passphrase, confirmation) => {
    const form = new FormData(); form.append('backup', file); form.append('passphrase', passphrase); form.append('confirmation', confirmation);
    return request('/api/backups/restore', { method: 'POST', body: form });
  },
};

export function queueTransactions(payload) {
  const key = queueKey();
  const queue = JSON.parse(localStorage.getItem(key) || '[]');
  queue.push({ id: crypto.randomUUID(), payload, createdAt: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(queue));
}

export async function flushTransactionQueue() {
  const key = queueKey();
  const queue = JSON.parse(localStorage.getItem(key) || '[]');
  const remaining = [];
  for (const item of queue) {
    try { await api.saveTransactions(item.payload); } catch { remaining.push(item); }
  }
  localStorage.setItem(key, JSON.stringify(remaining));
  return queue.length - remaining.length;
}
