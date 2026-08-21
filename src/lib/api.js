const QUEUE_KEY = 'hesab-yar-transaction-queue';

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new CustomEvent('hesabyar:auth-required'));
  if (!response.ok) throw Object.assign(new Error(body.message || 'خطا در ارتباط با سرور'), { status: response.status, code: body.code });
  return body;
}

export const api = {
  authStatus: () => request('/api/auth/status'),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
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
  const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  queue.push({ id: crypto.randomUUID(), payload, createdAt: new Date().toISOString() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function flushTransactionQueue() {
  const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  const remaining = [];
  for (const item of queue) {
    try { await api.saveTransactions(item.payload); } catch { remaining.push(item); }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  return queue.length - remaining.length;
}
