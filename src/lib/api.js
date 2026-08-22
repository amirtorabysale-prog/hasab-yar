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
  invoices: () => request('/api/invoices'),
  invoice: (id) => request(`/api/invoices/${id}`),
  saveInvoice: (payload) => request('/api/invoices', { method: 'POST', body: JSON.stringify(payload) }),
  markInvoicePaid: (id) => request(`/api/invoices/${id}/paid`, { method: 'POST', body: '{}' }),
  deleteInvoice: (id) => request(`/api/invoices/${id}`, { method: 'DELETE' }),
  closings: () => request('/api/closings'),
  closeDay: (payload) => request('/api/closings', { method: 'POST', body: JSON.stringify(payload) }),
  receipts: () => request('/api/receipts'),
  saveReceipt: (image, note = '') => { const form = new FormData(); form.append('image', image); form.append('note', note); return request('/api/receipts', { method: 'POST', body: form }); },
  products: () => request('/api/products'),
  saveProduct: (payload) => request(payload.id ? `/api/products/${payload.id}` : '/api/products', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  adjustStock: (id, quantity, note = '') => request(`/api/products/${id}/stock`, { method: 'POST', body: JSON.stringify({ quantity, note }) }),
  ask: (question) => request('/api/ask', { method: 'POST', body: JSON.stringify({ question }) }),
  voiceStats: () => request('/api/voice/stats'),
  learnings: () => request('/api/learnings'),
  saveLearning: (payload) => request('/api/learnings', { method: 'POST', body: JSON.stringify(payload) }),
  updateLearning: (id, payload) => request(`/api/learnings/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteLearning: (id) => request(`/api/learnings/${id}`, { method: 'DELETE' }),
  settings: (payload) => request('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
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
