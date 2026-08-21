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
  report: (range) => request(`/api/reports?range=${range}`),
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
