import {
  isNetworkQueueError, isPermanentQueueError, normalizeOfflineScope, offlineScopeKey, requireOfflineScope,
} from './offlineScope.js';

const QUEUE_KEY = 'hesab-yar-transaction-queue';
const CSRF_KEY = 'hesab-yar-csrf';
const WORKSPACE_KEY = 'hesab-yar-workspace';
const OFFLINE_SCOPE_KEY = 'hesab-yar-offline-scope';

function currentWorkspaceId() {
  try { return localStorage.getItem(WORKSPACE_KEY) || ''; }
  catch { return ''; }
}

export function currentOfflineScope() {
  try { return normalizeOfflineScope(JSON.parse(localStorage.getItem(OFFLINE_SCOPE_KEY) || 'null')); }
  catch { return null; }
}

export function rememberOfflineScope(value) {
  const scope = requireOfflineScope(value);
  try {
    localStorage.setItem(OFFLINE_SCOPE_KEY, JSON.stringify(scope));
    localStorage.setItem(WORKSPACE_KEY, scope.workspaceId);
  } catch { /* private mode */ }
  return scope;
}

export function clearOfflineSession() {
  try {
    localStorage.removeItem(WORKSPACE_KEY);
    localStorage.removeItem(OFFLINE_SCOPE_KEY);
    sessionStorage.removeItem(CSRF_KEY);
  } catch { /* storage can be unavailable */ }
}

function queueKey(scopeValue = currentOfflineScope()) {
  return `${QUEUE_KEY}:${offlineScopeKey(scopeValue)}`;
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

/**
 * شکست شبکه با پیام فارسی، نه متن داخلی مرورگر.
 *
 * وقتی سرور جواب نمی‌دهد، `fetch` یک `TypeError` با متن انگلیسی مرورگر پرتاب
 * می‌کند: «Failed to fetch» در Chrome و «NetworkError when attempting to fetch
 * resource» در Firefox. این متن از دهها نقطهٔ برنامه مستقیم با
 * `notify(error.message)` به کاربر می‌رسید و صفحهٔ ورود هم همان را به‌عنوان
 * دلیل ناموفق‌بودن ورود نشان می‌داد — یک جملهٔ انگلیسی وسط برنامهٔ فارسی که
 * نمی‌گوید کاربر باید چه کند.
 *
 * دو حالت از هم جدا می‌شوند، چون کار کاربر فرق می‌کند: یا اینترنت دستگاه قطع
 * است، یا دستگاه آنلاین است و سرور جواب نمی‌دهد — حالتی که با میزبانِ
 * خواب‌رونده سرِ اولین بازدید هر روز رخ می‌دهد و «قطعی اینترنت» خواندنش کاربر
 * را دنبال ایرادی در دستگاه خودش می‌فرستد.
 *
 * فقط `TypeError` ترجمه می‌شود. لغو کاربر و مهلت پردازش صدا با
 * `controller.abort(reason)` انجام می‌شوند و هر مقداری — حتی یک رشته — را
 * به‌عنوان دلیل رد می‌کنند؛ این‌ها باید دست‌نخورده عبور کنند وگرنه «لغو شد» به
 * «سرور پاسخ نداد» تبدیل می‌شود.
 */
async function reachServer(path, init) {
  try {
    return await fetch(path, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const offline = typeof navigator !== 'undefined' && navigator?.onLine === false;
    throw Object.assign(
      new Error(offline
        ? 'اینترنت دستگاه قطع است؛ پس از وصل‌شدن دوباره تلاش کن.'
        : 'سرور پاسخ نداد. چند لحظه صبر کن و دوباره تلاش کن.'),
      {
        code: offline ? 'NETWORK_OFFLINE' : 'NETWORK_UNREACHABLE',
        status: 0,
        cause: error,
      },
    );
  }
}

async function request(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const csrfToken = currentCsrfToken();
  const response = await reachServer(path, {
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
  const selectedUser = body.user || body.access?.user;
  if (selectedWorkspace?.id) {
    try { localStorage.setItem(WORKSPACE_KEY, selectedWorkspace.id); } catch { /* private mode */ }
    if (selectedUser?.id) rememberOfflineScope({ userId: selectedUser.id, workspaceId: selectedWorkspace.id });
    else {
      const remembered = currentOfflineScope();
      if (remembered) rememberOfflineScope({ ...remembered, workspaceId: selectedWorkspace.id });
    }
  }
  if (response.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/password') {
    clearOfflineSession();
    window.dispatchEvent(new CustomEvent('hesabyar:auth-required'));
  }
  if (response.status === 403 && body.code === 'CSRF_INVALID') rememberCsrfToken('');
  if (!response.ok) {
    const retryAfterHeader = Number(response.headers.get('retry-after'));
    throw Object.assign(new Error(body.message || 'خطا در ارتباط با سرور'), {
      status: response.status,
      code: body.code,
      provider: body.provider,
      details: body.details,
      requiresAction: Boolean(body.requiresAction),
      retryAfterSeconds: Number(body.retryAfterSeconds) || (Number.isFinite(retryAfterHeader) ? retryAfterHeader : 0),
    });
  }
  return body;
}

async function requestText(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const response = await reachServer(path, {
    credentials: 'same-origin',
    ...options,
    headers: protectedHeaders(mutating, options.headers),
  });
  const text = await response.text();
  if (response.status === 401) {
    clearOfflineSession();
    window.dispatchEvent(new CustomEvent('hesabyar:auth-required'));
  }
  if (!response.ok) {
    let body = {};
    try { body = JSON.parse(text); } catch { /* SDP endpoints may return plain text. */ }
    const retryAfterHeader = Number(response.headers.get('retry-after'));
    throw Object.assign(new Error(body.message || 'خطا در اتصال تایپ زنده'), {
      status: response.status,
      code: body.code,
      provider: body.provider,
      requiresAction: Boolean(body.requiresAction),
      retryAfterSeconds: Number(body.retryAfterSeconds) || (Number.isFinite(retryAfterHeader) ? retryAfterHeader : 0),
    });
  }
  return text;
}

export const api = {
  activeWorkspaceId: currentWorkspaceId,
  offlineScope: currentOfflineScope,
  rememberOfflineScope,
  clearOfflineSession,
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
  sessions: () => request('/api/auth/sessions'),
  revokeSession: (id) => request(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeOtherSessions: () => request('/api/auth/sessions/revoke-others', { method: 'POST', body: '{}' }),
  workspaces: () => request('/api/workspaces'),
  createWorkspace: (payload) => request('/api/workspaces', { method: 'POST', body: JSON.stringify(payload) }),
  members: () => request('/api/workspace/members'),
  addMember: (payload) => request('/api/workspace/members', { method: 'POST', body: JSON.stringify(payload) }),
  updateMember: (userId, role) => request(`/api/workspace/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  // انتخاب محیط ساده یا حرفه‌ای؛ پاسخ، دسترسی کامل تازه است.
  setExperience: (experience) => request('/api/workspace/experience', { method: 'PUT', body: JSON.stringify({ experience }) }),
  removeMember: (userId) => request(`/api/workspace/members/${userId}`, { method: 'DELETE' }),
  bootstrap: () => request('/api/bootstrap'),
  // تحلیل‌های سنگین دفتر، جدا از `bootstrap` تا نمایش اولیه پشتشان نماند.
  insights: () => request('/api/insights'),
  parseText: (text, { signal } = {}) => request('/api/parse/text', { method: 'POST', body: JSON.stringify({ text }), signal }),
  // `attemptId` شناسهٔ همان ضبط است. نشست realtime و بررسی فایل با یک شناسه
  // می‌روند تا سهمیه یک واحد کم کند، نه دو تا.
  parseAudio: (blob, { signal, hint, fallbackReason, workspaceId, attemptId } = {}) => {
    const form = new FormData();
    const extension = blob.type === 'audio/wav' ? 'wav' : 'webm';
    form.append('audio', blob, `voice.${extension}`);
    if (hint) form.append('hint', String(hint).slice(0, 500));
    if (fallbackReason) form.append('fallbackReason', String(fallbackReason).slice(0, 160));
    if (attemptId) form.append('attemptId', String(attemptId).slice(0, 80));
    return request('/api/parse/audio', {
      method: 'POST', body: form, signal,
      headers: {
        ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
        ...(attemptId ? { 'X-Voice-Attempt': String(attemptId).slice(0, 80) } : {}),
      },
    });
  },
  createRealtimeTranscription: (sdp, { signal, attemptId } = {}) => requestText('/api/voice/realtime/session', {
    method: 'POST',
    body: sdp,
    signal,
    headers: {
      'Content-Type': 'application/sdp',
      ...(attemptId ? { 'X-Voice-Attempt': String(attemptId).slice(0, 80) } : {}),
    },
  }),
  recordVoiceMetric: (payload) => request('/api/voice/metrics', { method: 'POST', body: JSON.stringify(payload) }),
  saveTransactions: (payload, { workspaceId } = {}) => request('/api/transactions', {
    method: 'POST', body: JSON.stringify(payload),
    headers: workspaceId ? { 'X-Workspace-Id': workspaceId } : undefined,
  }),
  transactions: (params = {}) => request(`/api/transactions?${new URLSearchParams(params)}`),
  latestTransaction: () => request('/api/transactions/latest'),
  updateTransaction: (id, payload) => request(`/api/transactions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  correctTransaction: (id, command) => request(`/api/transactions/${id}/correct`, { method: 'POST', body: JSON.stringify({ command }) }),
  redoTransaction: (id) => request(`/api/transactions/${id}/redo`, { method: 'POST', body: '{}' }),
  deleteTransaction: (id) => request(`/api/transactions/${id}`, { method: 'DELETE' }),
  report: (range) => request(`/api/reports?range=${range}`),
  overview: () => request('/api/overview'),
  snoozeAlert: (id, hours = 24) => request(`/api/alerts/${encodeURIComponent(id)}/snooze`, { method: 'POST', body: JSON.stringify({ hours }) }),
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
  taxAssistantSources: () => request('/api/tax-assistant/sources'),
  saveTaxAssistantSource: (payload) => request(payload.id ? `/api/tax-assistant/sources/${payload.id}` : '/api/tax-assistant/sources', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  taxAssistantQuestions: (status = '') => request(`/api/tax-assistant/questions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  askTaxAssistant: (payload) => request('/api/tax-assistant/questions', { method: 'POST', body: JSON.stringify(payload) }),
  resolveTaxAssistantQuestion: (id, payload) => request(`/api/tax-assistant/questions/${id}/resolve`, { method: 'POST', body: JSON.stringify(payload) }),
  accounts: () => request('/api/accounts'),
  saveAccount: (payload) => request(payload.id ? `/api/accounts/${payload.id}` : '/api/accounts', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  contacts: () => request('/api/contacts'),
  // کارت حساب یک طرف حساب: گردشش از دفتر کل با مانده‌گیری تجمعی.
  contactCard: (id, { from = '', to = '' } = {}) => request(`/api/contacts/${encodeURIComponent(id)}/card?${new URLSearchParams({ from, to })}`),
  saveContact: (payload) => request(payload.id ? `/api/contacts/${payload.id}` : '/api/contacts', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  deleteContact: (id) => request(`/api/contacts/${id}`, { method: 'DELETE' }),
  obligations: (status = 'open') => request(`/api/obligations?status=${encodeURIComponent(status)}`),
  saveObligation: (payload) => request(payload.id ? `/api/obligations/${payload.id}` : '/api/obligations', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  settleObligation: (id, payload = {}) => request(`/api/obligations/${id}/settle`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteObligation: (id) => request(`/api/obligations/${id}`, { method: 'DELETE' }),
  recurring: () => request('/api/recurring'),
  saveRecurring: (payload) => request('/api/recurring', { method: 'POST', body: JSON.stringify(payload) }),
  deleteRecurring: (id) => request(`/api/recurring/${id}`, { method: 'DELETE' }),
  // آورده و دارایی ثابت؛ ثبت عادی نیست چون سود دوره را تکان نمی‌دهد.
  saveCapitalEntry: (payload) => request('/api/capital-entries', { method: 'POST', body: JSON.stringify(payload) }),
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
  closingPreview: (day = '') => request(`/api/closings/preview${day ? `?day=${encodeURIComponent(day)}` : ''}`),
  closeDay: (payload) => request('/api/closings', { method: 'POST', body: JSON.stringify(payload) }),
  receipts: (status = '') => request(`/api/receipts${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  receipt: (id) => request(`/api/receipts/${id}`),
  saveReceipt: (image, note = '', accountId = 'cash') => { const form = new FormData(); form.append('image', image); form.append('note', note); form.append('accountId', accountId); return request('/api/receipts', { method: 'POST', body: form }); },
  updateReceipt: (id, payload) => request(`/api/receipts/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  confirmReceipt: (id, payload) => request(`/api/receipts/${id}/confirm`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteReceipt: (id) => request(`/api/receipts/${id}`, { method: 'DELETE' }),
  automationRules: (source = '') => request(`/api/automation-rules${source ? `?source=${encodeURIComponent(source)}` : ''}`),
  saveAutomationRule: (payload) => request('/api/automation-rules', { method: 'POST', body: JSON.stringify(payload) }),
  deleteAutomationRule: (id) => request(`/api/automation-rules/${id}`, { method: 'DELETE' }),
  products: () => request('/api/products'),
  inventoryOverview: () => request('/api/inventory/overview'),
  saveProduct: (payload) => request(payload.id ? `/api/products/${payload.id}` : '/api/products', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  adjustStock: (id, quantity, note = '', unitCost = null) => request(`/api/products/${id}/stock`, { method: 'POST', body: JSON.stringify({ quantity, note, unitCost }) }),
  ask: (question) => request('/api/ask', { method: 'POST', body: JSON.stringify({ question }) }),
  commercialStatus: () => request('/api/commercial/status'),
  updateWorkspacePlan: (workspaceId, payload) => request(`/api/commercial/admin/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'POST', body: JSON.stringify(payload) }),
  journalBatch: (documents, approvalState = 'draft') => request('/api/accounting/journal/batch', { method: 'POST', body: JSON.stringify({ documents, approvalState }) }),
  journalWorklist: () => request('/api/accounting/journal/worklist'),
  setJournalApproval: (id, state, reason = '') => request(`/api/accounting/journal/${encodeURIComponent(id)}/approval`, { method: 'POST', body: JSON.stringify({ state, reason }) }),
  automationPolicy: () => request('/api/automation-policy'),
  saveAutomationPolicy: (payload) => request('/api/automation-policy', { method: 'PUT', body: JSON.stringify(payload) }),
  // پرسش‌های خودِ کاربر — در محیط ساده هم در دسترس است.
  confirmations: () => request('/api/confirmations'),
  confirmPending: (id) => request(`/api/confirmations/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify({}) }),
  handOverPending: (id) => request(`/api/confirmations/${encodeURIComponent(id)}/handover`, { method: 'POST', body: JSON.stringify({}) }),
  // صف بررسی حسابدار: رویدادهایی که موتور اطمینان ثبتشان را متوقف کرده است.
  reviewQueue: (limit = 50) => request(`/api/financial-events/review-queue?limit=${encodeURIComponent(limit)}`),
  reviewAiProposal: (id) => request(`/api/financial-events/${encodeURIComponent(id)}/ai-proposal`, { method: 'POST', body: '{}' }),
  reviewAiFeedback: (id, proposalId, accepted, reason = '') => request(`/api/financial-events/${encodeURIComponent(id)}/ai-feedback`, { method: 'POST', body: JSON.stringify({ proposalId, accepted, reason }) }),
  eventAudit: (id) => request(`/api/financial-events/${encodeURIComponent(id)}/audit`),
  eventDecision: (id) => request(`/api/financial-events/${encodeURIComponent(id)}/decision`),
  answerEvent: (id, answer) => request(`/api/financial-events/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify(answer) }),
  approveEvent: (id, reason = '') => request(`/api/financial-events/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
  reverseEvent: (id, reason = '') => request(`/api/financial-events/${encodeURIComponent(id)}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) }),
  rejectEvent: (id, reason = '') => request(`/api/financial-events/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  journalTemplates: () => request('/api/accounting/templates'),
  saveJournalTemplate: (payload) => request(payload.id ? `/api/accounting/templates/${encodeURIComponent(payload.id)}` : '/api/accounting/templates', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  deleteJournalTemplate: (id) => request(`/api/accounting/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  chartOverview: () => request('/api/chart/overview'),
  importChartFile: (file, replace = false) => { const form = new FormData(); form.append('file', file); form.append('replace', String(replace)); return request('/api/import/chart', { method: 'POST', body: form }); },
  importAnalyticsFile: (file) => { const form = new FormData(); form.append('file', file); return request('/api/import/analytics', { method: 'POST', body: form }); },
  importOpeningBalances: (file, { amountUnit = 'toman', replace = false } = {}) => {
    const form = new FormData();
    form.append('file', file);
    form.append('amountUnit', amountUnit);
    form.append('replace', String(replace));
    return request('/api/import/opening-balances', { method: 'POST', body: form });
  },
  transferFields: () => request('/api/accountant-transfer/fields'),
  downloadImportTemplate: async () => {
    const response = await reachServer('/api/import/template', { credentials: 'same-origin', headers: protectedHeaders(false) });
    if (!response.ok) throw new Error('دریافت الگوی اکسل ممکن نشد.');
    return { blob: await response.blob(), fileName: 'hesab-yar-import-templates.xlsx' };
  },
  installChartTemplate: () => request('/api/chart/template', { method: 'POST', body: '{}' }),
  importChart: (csv, replace = false) => request('/api/chart/import', { method: 'POST', body: JSON.stringify({ csv, replace }) }),
  saveChartAccount: (payload) => request(payload.id ? `/api/chart/accounts/${encodeURIComponent(payload.id)}` : '/api/chart/accounts', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  clearChartMappings: () => request('/api/chart/mappings', { method: 'DELETE' }),
  mapLedgerAccount: (ledgerAccountId, chartAccountId) => request(`/api/chart/mappings/${encodeURIComponent(ledgerAccountId)}`, { method: 'PUT', body: JSON.stringify({ chartAccountId }) }),
  applyChartSuggestions: ({ refine = false } = {}) => request('/api/chart/mappings/suggest', { method: 'POST', body: JSON.stringify({ refine }) }),
  mapLedgerAccountsInBulk: (ledgerAccountIds, chartAccountId) => request('/api/chart/mappings/bulk', { method: 'POST', body: JSON.stringify({ ledgerAccountIds, chartAccountId }) }),
  attachCounterpartyAnalytics: () => request('/api/chart/analytics/attach', { method: 'POST' }),
  settleVatPeriod: (payload = {}) => request('/api/tax/settle-vat', { method: 'POST', body: JSON.stringify(payload) }),
  transferBetweenAccounts: (payload) => request('/api/accounts/transfer', { method: 'POST', body: JSON.stringify(payload) }),
  cheques: (query = {}) => request(`/api/cheques?${new URLSearchParams(query)}`),
  recordCheque: (payload) => request('/api/cheques', { method: 'POST', body: JSON.stringify(payload) }),
  clearCheque: (id, payload = {}) => request(`/api/cheques/${encodeURIComponent(id)}/clear`, { method: 'POST', body: JSON.stringify(payload) }),
  bounceCheque: (id, payload = {}) => request(`/api/cheques/${encodeURIComponent(id)}/bounce`, { method: 'POST', body: JSON.stringify(payload) }),
  payrollRuns: () => request('/api/payroll'),
  importPayrollFile: (file, { period, occurredAt, note } = {}) => {
    const form = new FormData();
    form.append('file', file);
    form.append('period', period || '');
    if (occurredAt) form.append('occurredAt', occurredAt);
    if (note) form.append('note', note);
    return request('/api/payroll/import', { method: 'POST', body: form });
  },
  payPayrollSalaries: (id, payload = {}) => request(`/api/payroll/${encodeURIComponent(id)}/pay-salaries`, { method: 'POST', body: JSON.stringify(payload) }),
  payPayrollLiability: (id, kind, payload = {}) => request(`/api/payroll/${encodeURIComponent(id)}/pay/${kind}`, { method: 'POST', body: JSON.stringify(payload) }),
  reversePayrollRun: (id) => request(`/api/payroll/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  dimensionBalance: (params = {}) => request(`/api/chart/dimensions/balance?${new URLSearchParams(params)}`),
  saveAnalytic: (payload) => request(payload.id ? `/api/chart/analytics/${encodeURIComponent(payload.id)}` : '/api/chart/analytics', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  saveCostCenter: (payload) => request(payload.id ? `/api/chart/cost-centers/${encodeURIComponent(payload.id)}` : '/api/chart/cost-centers', { method: payload.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }),
  firmPortfolio: ({ month = '', refresh = false } = {}) => request(`/api/firm/portfolio?${new URLSearchParams({ ...(month ? { month } : {}), ...(refresh ? { refresh: '1' } : {}) })}`),
  collaborationOverview: (month = '') => request(`/api/collaboration/overview${month ? `?month=${encodeURIComponent(month)}` : ''}`),
  monthlyAccountantPackage: (month = '') => request(`/api/collaboration/monthly-package${month ? `?month=${encodeURIComponent(month)}` : ''}`),
  accountingTransferOverview: (month = '', target = 'generic-csv') => request(`/api/accountant-transfer/overview?${new URLSearchParams({ month, target })}`),
  saveAccountingTransferSettings: (payload) => request('/api/accountant-transfer/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  saveTransferTemplate: (targetSystem, file) => { const form = new FormData(); form.append('file', file); form.append('targetSystem', targetSystem); return request('/api/accountant-transfer/template', { method: 'POST', body: form }); },
  fillTransferMappingsFromChart: (targetSystem, overwrite = false) => request('/api/accountant-transfer/mappings/from-chart', { method: 'POST', body: JSON.stringify({ targetSystem, overwrite }) }),
  saveAccountingTransferMapping: (ledgerAccountId, payload) => request(`/api/accountant-transfer/mappings/${encodeURIComponent(ledgerAccountId)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  createAccountingTransferBatch: (payload) => request('/api/accountant-transfer/batches', { method: 'POST', body: JSON.stringify(payload) }),
  accountingTransferBatches: (params = {}) => request(`/api/accountant-transfer/batches?${new URLSearchParams(params)}`),
  updateAccountingTransferBatchStatus: (id, status, note = '') => request(`/api/accountant-transfer/batches/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status, note }) }),
  accountingTransferValidations: (id) => request(`/api/accountant-transfer/batches/${encodeURIComponent(id)}/validations`),
  createAccountingTransferValidation: (id, payload) => request(`/api/accountant-transfer/batches/${encodeURIComponent(id)}/validations`, { method: 'POST', body: JSON.stringify(payload) }),
  createCollaborationRequest: (payload) => request('/api/collaboration/requests', { method: 'POST', body: JSON.stringify(payload) }),
  answerCollaborationRequest: (id, answer) => request(`/api/collaboration/requests/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  resolveCollaborationRequest: (id) => request(`/api/collaboration/requests/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: '{}' }),
  savePilotCheckin: (payload) => request('/api/pilot/checkins', { method: 'POST', body: JSON.stringify(payload) }),
  pilotPortfolio: () => request('/api/pilot/portfolio'),
  operationsOverview: () => request('/api/operations/overview'),
  financialDna: (months = 6) => request(`/api/financial-dna?months=${months}`),
  downloadMonthlyAccountantPackage: async (month = '') => {
    const path = `/api/collaboration/monthly-package/download${month ? `?month=${encodeURIComponent(month)}` : ''}`;
    const response = await reachServer(path, { credentials: 'same-origin', headers: protectedHeaders(false) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.message || 'ساخت بستهٔ پایان ماه انجام نشد.'), { status: response.status, code: body.code });
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `hesab-yar-accountant-${month || new Date().toISOString().slice(0, 7)}.json`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { fileName, bytes: blob.size };
  },
  downloadAccountingTransferBatch: async (id, fallbackFileName = '', options = {}) => {
    const response = await reachServer(`/api/accountant-transfer/batches/${encodeURIComponent(id)}/download`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: protectedHeaders(true, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        confirmRedownload: options.confirmRedownload === true,
        reason: String(options.reason || ''),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.message || 'دریافت خروجی حسابداری انجام نشد.'), {
        status: response.status, code: body.code, details: body.details,
      });
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackFileName || `hesab-yar-ledger-${id}.csv`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return {
      fileName, bytes: blob.size,
      batchId: response.headers.get('x-hasabyar-batch-id') || id,
      downloadCount: Number(response.headers.get('x-hasabyar-download-count') || 0),
    };
  },
  voiceStats: () => request('/api/voice/stats'),
  voiceStatus: () => request('/api/voice/status'),
  learnings: () => request('/api/learnings'),
  saveLearning: (payload) => request('/api/learnings', { method: 'POST', body: JSON.stringify(payload) }),
  updateLearning: (id, payload) => request(`/api/learnings/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteLearning: (id) => request(`/api/learnings/${id}`, { method: 'DELETE' }),
  settings: (payload) => request('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  backupStatus: () => request('/api/backups/status'),
  createServerSnapshot: () => request('/api/backups/snapshot', { method: 'POST', body: '{}' }),
  downloadBackup: async (passphrase) => {
    const response = await reachServer('/api/backups/export', {
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

function readTransactionQueue(scopeValue) {
  try {
    const value = JSON.parse(localStorage.getItem(queueKey(scopeValue)) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function transactionQueueSnapshot(scopeValue = currentOfflineScope()) {
  const scope = requireOfflineScope(scopeValue);
  return readTransactionQueue(scope).filter((item) => (
    item?.userId === scope.userId && item?.workspaceId === scope.workspaceId
  ));
}

export function queueTransactions(payload, scopeValue = currentOfflineScope()) {
  const scope = requireOfflineScope(scopeValue);
  const key = queueKey(scope);
  const queue = readTransactionQueue(scope);
  const item = {
    id: crypto.randomUUID(),
    payload,
    ...scope,
    state: 'queued',
    attempts: 0,
    lastError: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  queue.push(item);
  localStorage.setItem(key, JSON.stringify(queue));
  return item;
}

export async function flushTransactionQueue(scopeValue = currentOfflineScope()) {
  const scope = requireOfflineScope(scopeValue);
  const key = queueKey(scope);
  const queue = transactionQueueSnapshot(scope);
  const remaining = [];
  let synced = 0;
  let failed = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (item.state === 'failed') { remaining.push(item); failed += 1; continue; }
    try {
      await api.saveTransactions(item.payload, { workspaceId: scope.workspaceId });
      synced += 1;
    } catch (error) {
      if (isNetworkQueueError(error)) {
        // سرور در دسترس نیست، پس بقیهٔ صف هم همین حالا همین را می‌گیرد. قلم
        // جاری و همهٔ قلم‌های نرسیده دست‌نخورده و بدون افزایش شمارش تلاش سر
        // جایشان می‌مانند: یک میزبانِ خواب نباید ثبت آفلاین کاربر را به مرز
        // «بررسی دستی» برساند.
        remaining.push(...queue.slice(index));
        break;
      }
      const permanent = isPermanentQueueError(error);
      remaining.push({
        ...item,
        state: permanent ? 'failed' : 'queued',
        attempts: Number(item.attempts || 0) + 1,
        lastError: String(error?.message || 'خطای همگام‌سازی').slice(0, 300),
        updatedAt: new Date().toISOString(),
      });
      if (permanent) failed += 1;
    }
  }
  localStorage.setItem(key, JSON.stringify(remaining));
  return { synced, failed, pending: remaining.filter((item) => item.state !== 'failed').length };
}
