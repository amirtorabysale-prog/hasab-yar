import 'node:process';
import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  accountingTransferBatchFile, accountingTransferOverview, activeWorkspaceDatabase, addWorkspaceMember, adjustStock, allWorkspaces, answerCollaborationRequest, answerFinancialQuestion, authenticateUser, beginProviderUsage, changePassword, claimAccountingTransferBatchDownload, clearLoginFailures, closeBankReconciliation, closeDay, commercialStatus, createAccountingTransferBatch, createAccountingTransferValidation, createCollaborationRequest, createInvoice, createSession, createTransactionFromStatementLine, createWorkspace, deleteContact,
  deleteAutomationRule, deleteInvoice, deleteLearning, deleteObligation, deleteReceipt, deleteRecurringRule, deleteSession, deleteTransaction,
  ensureAdmin, financialOverview, finishProviderUsage, getCategories, getInvoice, getLearnings, getReceipt, getReconciliationImport, getSettings, inventoryOverview,
  correctLatestTransaction, findPotentialDuplicates, getToday, getTransaction, insertTransactions, issueInvoice, latestTransaction, listAccounts, listContacts, listDailyClosings, listInvoices, listObligations, listProducts, listUserSessions, listUserWorkspaces, listWorkspaceMembers, previewDayClosing,
  importBankStatement, ignoreReconciliationLine, listAutomationRules, listCollaborationRequests, listReceipts, listReconciliationImports, listRecurringRules, listTaxRates, listTransactions, loginThrottle, markInvoicePaid, matchReconciliationLine, materializeRecurringRules, monthlyAccountantPackage, pilotPortfolio, pilotWorkspaceDashboard, receiptCandidates, receiptImage, recordInvoicePayment, recordLoginFailure, recordRealtimeProviderDuration, recordVoiceMetric,
  applyChartSuggestions, chartOverview, dimensionReport, firmPortfolio, importChart, installChartTemplate,
  importAnalyticsFile, importChartFile, importOpeningBalanceFile, importTemplateWorkbook, transferFieldCatalog,
  saveAccountingTransferTemplate,
  createJournalDocuments, deleteJournalTemplate, journalWorklistOverview, listJournalTemplates,
  fillTransferMappingsFromChart,
  saveJournalTemplate, submitJournalApproval,
  mapLedgerAccount, saveAnalytic, saveChartAccountEntry, saveCostCenterEntry,
  listAccountingTransferBatches, listAccountingTransferValidations, recordAudit, removeWorkspaceMember, report, resolveCollaborationRequest, revokeOtherUserSessions, revokeUserSession, revokeWorkspaceSessions, runInWorkspace, saveAccount, saveAccountingTransferMapping, saveAccountingTransferSettings, saveContact, saveLearning, saveObligation, savePilotCheckin, saveRecurringRule, saveSettings, settleObligation, snoozeFinancialAlert,
  confirmReceipt, redoTransaction, saveAutomationRule, saveProduct, saveReceipt, saveTaxRate, taxReport, typicalAmounts, updateAccountingTransferBatchStatus, updateLearning, updateReceipt, updateTransaction, updateWorkspaceCommercialPlan, updateWorkspaceMember, userFromSession, voiceStats, workspaceForUser, workspaceOperationalSignals,
  askTaxAssistant, listTaxAssistantQuestions, listTaxKnowledgeSources, resolveTaxAssistantQuestion, saveTaxKnowledgeSource,
} from './db.js';
import { parseFinancialText } from './parser.js';
import { previewCorrection } from '../shared/correction.js';
import { minimumRoleForRequest, roleAllows } from './access.js';
import {
  automaticBackupConfigured, automaticBackupStatus, backupSummary, createPortableBackup,
  openEncryptedBackup, restorePortableBackup, writeServerBackup,
} from './backup.js';
import {
  accountingPeriods, createAdjustingJournal, listJournal, listLedgerAccounts, lockAccountingPeriod,
  periodForDate, reopenAccountingPeriod, trialBalance,
} from './accounting.js';
import { accountLoginFingerprint, csrfTokenFor, csrfTokenIsValid, originMatchesHost, requestFingerprint, setSecurityHeaders, validateSecurityConfiguration } from './security.js';
import { parseFinancialAudio } from './voice.js';
import { createRealtimeTranscriptionCall } from './openaiRealtime.js';
import { voiceProviderStatus } from './voiceProviderState.js';
import { extractReceiptData, receiptOcrConfigured } from './receiptOcr.js';
import { audioDurationMs } from './collaboration.js';
import { healthPayload } from './release.js';

const app = express();
const port = Number(process.env.PORT || 4173);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
const statementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const chartUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
// الگوی انتقال پارسیان یک دیتابیس Access کامل است و چند مگابایت می‌شود.
const transferTemplateUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024, files: 1 } });
const securityConfig = validateSecurityConfiguration();
const adminState = ensureAdmin();
if (securityConfig.production) app.set('trust proxy', securityConfig.trustProxyHops);

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function sessionCookie(token, maxAge = 7 * 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `hy_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Priority=High; Max-Age=${maxAge}${secure}`;
}

function workspaceCookie(workspaceId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `hy_workspace=${encodeURIComponent(workspaceId)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}${secure}`;
}

function accessPayload(user, requestedWorkspaceId = '') {
  const workspaces = listUserWorkspaces(user.id);
  const workspace = workspaceForUser(user.id, requestedWorkspaceId) || workspaces[0] || null;
  return {
    user: { id: user.id, username: user.username, displayName: user.displayName || user.username, mustChangePassword: Boolean(user.mustChangePassword), isSystemAdmin: user.username === String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase() },
    workspaces,
    workspace,
  };
}

function requireSystemAdmin(request, response) {
  if (request.user?.username === String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase()) return true;
  response.status(403).json({ code: 'SYSTEM_ADMIN_REQUIRED', message: 'این بخش فقط برای مدیر پایلوت حساب‌یار در دسترس است.' });
  return false;
}

function requireRank(request, response, minimum) {
  if (roleAllows(request.workspace?.role, minimum)) return true;
  response.status(403).json({ code: 'ROLE_FORBIDDEN', message: 'نقش فعلی برای انجام این کار اجازه ندارد.' });
  return false;
}

app.disable('x-powered-by');
app.use((request, response, next) => {
  setSecurityHeaders(response, { production: process.env.NODE_ENV === 'production' });
  if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_request, response) => response.json(healthPayload()));
app.get('/api/auth/status', (request, response) => {
  if (!adminState.configured) return response.status(503).json({ code: 'ADMIN_NOT_CONFIGURED', message: 'رمز مالک روی سرور تنظیم نشده است.' });
  const sessionToken = cookies(request).hy_session;
  const user = userFromSession(sessionToken);
  return response.json({ authenticated: Boolean(user), csrfToken: user ? csrfTokenFor(sessionToken) : null, ...(user ? accessPayload(user, request.get('x-workspace-id')) : {}) });
});
app.post('/api/auth/login', (request, response) => {
  if (!adminState.configured) return response.status(503).json({ code: 'ADMIN_NOT_CONFIGURED', message: 'ابتدا ADMIN_PASSWORD را روی سرور تنظیم کن.' });
  const networkFingerprint = requestFingerprint(request.ip || request.socket.remoteAddress || 'unknown', request.get('user-agent'));
  const accountFingerprint = accountLoginFingerprint(request.body?.username);
  const throttles = [loginThrottle(networkFingerprint), loginThrottle(accountFingerprint)];
  const throttle = throttles.reduce((strictest, item) => (
    item.retryAfterSeconds > strictest.retryAfterSeconds ? item : strictest
  ), { blocked: false, retryAfterSeconds: 0 });
  if (throttle.blocked) {
    response.setHeader('Retry-After', String(throttle.retryAfterSeconds));
    return response.status(429).json({ code: 'LOGIN_RATE_LIMIT', message: 'تلاش‌های ورود زیاد بود؛ کمی بعد دوباره امتحان کن.' });
  }
  const user = authenticateUser(request.body?.username, request.body?.password);
  if (!user) {
    recordLoginFailure(networkFingerprint);
    recordLoginFailure(accountFingerprint, new Date(), { limit: 20, lockMinutes: 30 });
    return response.status(401).json({ code: 'INVALID_LOGIN', message: 'نام کاربری یا رمز درست نیست.' });
  }
  clearLoginFailures(networkFingerprint);
  clearLoginFailures(accountFingerprint);
  const session = createSession(user.id);
  response.setHeader('Set-Cookie', sessionCookie(session.token));
  return response.json({ authenticated: true, csrfToken: csrfTokenFor(session.token), ...accessPayload(user) });
});
app.use('/api', (request, response, next) => {
  const sessionToken = cookies(request).hy_session;
  const user = userFromSession(sessionToken);
  if (!user) return response.status(401).json({ code: 'AUTH_REQUIRED', message: 'برای دیدن اطلاعات مالی وارد حساب شو.' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    if (request.headers.origin && !originMatchesHost(request.headers.origin, request.get('host'))) return response.status(403).json({ code: 'INVALID_ORIGIN', message: 'مبدأ درخواست معتبر نیست.' });
    if (!csrfTokenIsValid(sessionToken, request.get('x-csrf-token'))) return response.status(403).json({ code: 'CSRF_INVALID', message: 'نشست امنیتی معتبر نیست؛ صفحه را تازه‌سازی کن.' });
  }
  request.user = user;
  request.sessionToken = sessionToken;
  const requestedWorkspace = request.get('x-workspace-id') || (['GET', 'HEAD'].includes(request.method) ? request.query.workspace : '') || cookies(request).hy_workspace;
  const workspace = workspaceForUser(user.id, requestedWorkspace);
  if (!workspace) return response.status(403).json({ code: 'WORKSPACE_FORBIDDEN', message: 'به این دفتر دسترسی نداری.' });
  request.workspace = workspace;
  response.append('Set-Cookie', workspaceCookie(workspace.id));
  return runInWorkspace(workspace.id, { ...workspace, userId: user.id }, next);
});
app.use('/api', (request, response, next) => {
  const path = request.path;
  if (request.user.mustChangePassword && !['/auth/password', '/auth/logout'].includes(path)) {
    return response.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'پیش از ادامه رمز موقت را تغییر بده.' });
  }
  const minimum = minimumRoleForRequest(request.method, path);
  return requireRank(request, response, minimum) ? next() : undefined;
});
app.post('/api/auth/logout', (request, response) => {
  deleteSession(request.sessionToken);
  response.setHeader('Set-Cookie', sessionCookie('', 0));
  return response.status(204).end();
});
app.post('/api/auth/password', (request, response) => {
  const result = changePassword(request.user.id, request.body?.currentPassword, request.body?.newPassword);
  if (!result.changed) {
    const status = result.code === 'CURRENT_PASSWORD_INVALID' ? 401 : 400;
    return response.status(status).json({ code: result.code, message: result.message || 'رمز فعلی درست نیست.' });
  }
  response.setHeader('Set-Cookie', sessionCookie('', 0));
  return response.status(204).end();
});
app.get('/api/auth/sessions', (request, response) => {
  return response.json({ items: listUserSessions(request.user.id, request.sessionToken) });
});
app.delete('/api/auth/sessions/:sessionId', (request, response) => {
  const result = revokeUserSession(request.user.id, request.params.sessionId, request.sessionToken);
  if (result.revoked) return response.status(204).end();
  const current = result.code === 'CURRENT_SESSION';
  return response.status(current ? 400 : 404).json({
    code: result.code,
    message: current ? 'نشست فعلی را از مسیر خروج امن ببند.' : 'نشست پیدا نشد یا قبلاً بسته شده است.',
  });
});
app.post('/api/auth/sessions/revoke-others', (request, response) => {
  return response.json(revokeOtherUserSessions(request.user.id, request.sessionToken));
});
app.get('/api/workspaces', (request, response) => response.json(accessPayload(request.user, request.workspace.id)));
app.post('/api/workspaces', (request, response, next) => {
  try {
    const workspace = createWorkspace(request.user.id, request.body || {});
    return response.status(201).json({ workspace, workspaces: listUserWorkspaces(request.user.id) });
  } catch (error) { error.status ||= 400; return next(error); }
});
app.get('/api/workspace/members', (request, response) => {
  if (!requireRank(request, response, 'manager')) return undefined;
  return response.json({ items: listWorkspaceMembers(request.workspace.id) });
});
app.post('/api/workspace/members', (request, response, next) => {
  try { return response.status(201).json({ item: addWorkspaceMember(request.workspace.id, request.body || {}) }); }
  catch (error) { error.status ||= 400; return next(error); }
});
app.put('/api/workspace/members/:userId', (request, response, next) => {
  try {
    const item = updateWorkspaceMember(request.workspace.id, request.params.userId, request.body?.role);
    return item ? response.json({ item }) : response.status(404).json({ message: 'عضو پیدا نشد.' });
  } catch (error) { error.status ||= 400; return next(error); }
});
app.delete('/api/workspace/members/:userId', (request, response, next) => {
  try { return response.status(removeWorkspaceMember(request.workspace.id, request.params.userId) ? 204 : 404).end(); }
  catch (error) { error.status ||= 400; return next(error); }
});
// میز کار دفتر حسابداری. فقط پرونده‌هایی که همین کاربر عضوشان است دیده می‌شوند.
app.get('/api/firm/portfolio', (request, response, next) => {
  try {
    return response.json(firmPortfolio(request.user.id, {
      month: request.query.month || '',
      refresh: request.query.refresh === '1' || request.query.refresh === 'true',
    }));
  } catch (error) { return next(error); }
});
app.get('/api/bootstrap', (request, response) => {
  materializeRecurringRules();
  return response.json({
    ...getToday(), categories: getCategories(), settings: getSettings(), learnings: getLearnings(),
    averages: typicalAmounts(), overview: financialOverview(), accounts: listAccounts(), contacts: listContacts(),
    obligations: listObligations({ status: 'open' }), recurring: listRecurringRules(), closings: listDailyClosings(), closingPreview: previewDayClosing(), access: accessPayload(request.user, request.workspace.id),
  });
});
app.post('/api/parse/text', (request, response) => {
  const text = String(request.body?.text || '').trim();
  if (!text || text.length > 1500) return response.status(400).json({ message: 'متن ثبت مالی معتبر نیست.' });
  return response.json(parseFinancialText(text, { learnings: getLearnings(), averages: typicalAmounts() }));
});
app.post('/api/parse/audio', upload.single('audio'), async (request, response, next) => {
  const startedAt = Date.now();
  let usageId = null;
  let durationMs = 0;
  try {
    if (!request.file) return response.status(400).json({ message: 'فایل صدا دریافت نشد.' });
    durationMs = audioDurationMs(request.file.buffer, request.file.mimetype) || Math.min(60_000, Math.max(0, Number(request.body?.durationMs) || 0));
    usageId = beginProviderUsage('server_voice', 'pipeline');
    const result = await parseFinancialAudio({ buffer: request.file.buffer, mimeType: request.file.mimetype || 'application/octet-stream', hint: request.body?.hint, categories: getCategories(), learnings: getLearnings(), averages: typicalAmounts() });
    recordVoiceMetric({
      provider: result.provider || result.engine,
      model: result.model,
      durationMs,
      latencyMs: Date.now() - startedAt,
      transactionCount: result.transactions?.length,
      needsReview: result.transactions?.some((item) => item.needsReview),
      errorCode: request.body?.fallbackReason,
    });
    finishProviderUsage(usageId, { provider: result.provider || result.engine, durationMs });
    return response.json(result);
  } catch (error) {
    if (usageId) finishProviderUsage(usageId, { provider: error.provider || 'pipeline', durationMs, succeeded: false, errorCode: error.code });
    if (!['PLAN_QUOTA_EXCEEDED', 'PROVIDER_BUDGET_EXCEEDED'].includes(error.code)) recordVoiceMetric({ provider: 'pipeline', durationMs, latencyMs: Date.now() - startedAt, succeeded: false, errorCode: error.code });
    return next(error);
  }
});
app.post('/api/voice/realtime/session', express.text({ type: ['application/sdp', 'text/plain'], limit: '128kb' }), async (request, response, next) => {
  let usageId = null;
  try {
    usageId = beginProviderUsage('realtime_session', 'openai');
    const answer = await createRealtimeTranscriptionCall({
      sdp: request.body,
      categories: getCategories(),
      learnings: getLearnings(),
      userId: request.user.id,
    });
    finishProviderUsage(usageId, { provider: 'openai' });
    return response.type('application/sdp').send(answer);
  } catch (error) {
    if (usageId) finishProviderUsage(usageId, { provider: 'openai', succeeded: false, errorCode: error.code });
    return next(error);
  }
});
app.post('/api/transactions', (request, response, next) => {
  try {
    const transactions = request.body?.transactions;
    if (!Array.isArray(transactions) || !transactions.length || transactions.length > 20) return response.status(400).json({ message: 'حداقل یک تراکنش معتبر لازم است.' });
    if (!request.body?.allowDuplicates) {
      const duplicates = findPotentialDuplicates(transactions);
      if (duplicates.length) throw Object.assign(new Error('یک ثبت بسیار مشابه در چند دقیقهٔ اخیر پیدا شد.'), { code: 'POSSIBLE_DUPLICATE', status: 409, details: { duplicates } });
    }
    const ids = insertTransactions({ transcript: request.body.transcript, transactions });
    return response.status(201).json({ ids, ...getToday() });
  } catch (error) { return next(error); }
});
app.get('/api/reports', (request, response) => response.json(report(['week', 'month', 'quarter'].includes(request.query.range) ? request.query.range : 'month')));
app.get('/api/overview', (_request, response) => response.json(financialOverview()));
app.post('/api/alerts/:id/snooze', (request, response, next) => { try { return response.json({ item: snoozeFinancialAlert(request.params.id, request.body || {}) }); } catch (error) { return next(error); } });
app.get('/api/accounting/accounts', (_request, response) => response.json({ items: listLedgerAccounts(activeWorkspaceDatabase()) }));
app.get('/api/accounting/trial-balance', (request, response, next) => {
  try { return response.json(trialBalance(activeWorkspaceDatabase(), request.query.through)); }
  catch (error) { return next(error); }
});
app.get('/api/accounting/journal', (request, response) => response.json(listJournal(activeWorkspaceDatabase(), request.query)));
app.post('/api/accounting/journal', (request, response, next) => {
  try {
    const item = createAdjustingJournal(activeWorkspaceDatabase(), request.body || {}, { createdBy: request.user.id, timeZone: getSettings().timezone });
    recordAudit('create', 'adjusting_journal', item.id, { memo: request.body?.memo });
    return response.status(201).json({ item });
  } catch (error) { return next(error); }
});
// فاز ۳ — ثبت انبوه، کارتابل تأیید و الگوی سند.
app.post('/api/accounting/journal/batch', (request, response, next) => {
  try { return response.status(201).json(createJournalDocuments(request.body?.documents)); }
  catch (error) { return next(error); }
});
app.get('/api/accounting/journal/worklist', (request, response, next) => {
  try { return response.json(journalWorklistOverview(request.query)); } catch (error) { return next(error); }
});
app.post('/api/accounting/journal/:id/approval', (request, response, next) => {
  try { return response.json(submitJournalApproval(request.params.id, request.body?.state, request.body?.reason || '')); }
  catch (error) { return next(error); }
});
app.get('/api/accounting/templates', (_request, response, next) => {
  try { return response.json({ items: listJournalTemplates() }); } catch (error) { return next(error); }
});
app.post('/api/accounting/templates', (request, response, next) => {
  try { return response.status(201).json({ item: saveJournalTemplate(request.body || {}) }); } catch (error) { return next(error); }
});
app.put('/api/accounting/templates/:id', (request, response, next) => {
  try { return response.json({ item: saveJournalTemplate({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
});
app.delete('/api/accounting/templates/:id', (request, response) => response.status(deleteJournalTemplate(request.params.id) ? 204 : 404).end());
app.get('/api/accounting/periods', (_request, response) => response.json({ items: accountingPeriods(activeWorkspaceDatabase()), currentPeriod: periodForDate(new Date(), getSettings().timezone) }));
app.post('/api/accounting/periods/:period/lock', (request, response, next) => {
  try {
    const item = lockAccountingPeriod(activeWorkspaceDatabase(), request.params.period, request.user.id);
    recordAudit('lock', 'accounting_period', request.params.period, {});
    return response.json({ item });
  } catch (error) { return next(error); }
});
app.post('/api/accounting/periods/:period/reopen', (request, response, next) => {
  try {
    const item = reopenAccountingPeriod(activeWorkspaceDatabase(), request.params.period, request.user.id, request.body?.reason);
    recordAudit('reopen', 'accounting_period', request.params.period, { reason: request.body?.reason });
    return response.json({ item });
  } catch (error) { return next(error); }
});
// فاز ۲ — کدینگ دفتر، تفصیلی شناور و مرکز هزینه.
app.get('/api/chart/overview', (_request, response, next) => {
  try { return response.json(chartOverview()); } catch (error) { return next(error); }
});
app.post('/api/chart/template', (request, response, next) => {
  try { return response.status(201).json(installChartTemplate()); } catch (error) { return next(error); }
});
// ورود داده از اکسل و پارسیان. تشخیص xlsx یا CSV از روی بایت فایل است، نه پسوند.
app.get('/api/import/template', (_request, response, next) => {
  try {
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', 'attachment; filename="hesab-yar-import-templates.xlsx"');
    return response.send(importTemplateWorkbook());
  } catch (error) { return next(error); }
});
app.post('/api/import/chart', chartUpload.single('file'), (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
    return response.status(201).json(importChartFile(request.file.buffer, request.file.originalname, {
      replace: request.body?.replace === 'true' || request.body?.replace === true,
    }));
  } catch (error) { return next(error); }
});
app.post('/api/import/analytics', chartUpload.single('file'), (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
    return response.status(201).json(importAnalyticsFile(request.file.buffer, request.file.originalname));
  } catch (error) { return next(error); }
});
app.post('/api/import/opening-balances', chartUpload.single('file'), (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
    return response.status(201).json(importOpeningBalanceFile(request.file.buffer, request.file.originalname, {
      amountUnit: request.body?.amountUnit,
      replace: request.body?.replace === 'true' || request.body?.replace === true,
      occurredAt: request.body?.occurredAt || '',
    }));
  } catch (error) { return next(error); }
});
app.get('/api/accountant-transfer/fields', (_request, response) => response.json(transferFieldCatalog()));
app.post('/api/chart/import', chartUpload.single('chart'), (request, response, next) => {
  try {
    const text = request.file ? request.file.buffer.toString('utf8') : String(request.body?.csv || '');
    if (!text.trim()) return response.status(400).json({ code: 'CHART_FILE_EMPTY', message: 'فایل کدینگ خالی است.' });
    return response.status(201).json(importChart(text, { replace: request.body?.replace === 'true' || request.body?.replace === true }));
  } catch (error) { return next(error); }
});
app.post('/api/chart/accounts', (request, response, next) => {
  try { return response.status(201).json({ item: saveChartAccountEntry(request.body || {}) }); } catch (error) { return next(error); }
});
app.put('/api/chart/accounts/:id', (request, response, next) => {
  try { return response.json({ item: saveChartAccountEntry({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
});
app.put('/api/chart/mappings/:ledgerAccountId', (request, response, next) => {
  try { return response.json(mapLedgerAccount(request.params.ledgerAccountId, request.body?.chartAccountId || null)); } catch (error) { return next(error); }
});
app.post('/api/chart/mappings/suggest', (_request, response, next) => {
  try { return response.json(applyChartSuggestions()); } catch (error) { return next(error); }
});
app.get('/api/chart/dimensions/balance', (request, response, next) => {
  try { return response.json(dimensionReport(request.query)); } catch (error) { return next(error); }
});
app.post('/api/chart/analytics', (request, response, next) => {
  try { return response.status(201).json({ item: saveAnalytic(request.body || {}) }); } catch (error) { return next(error); }
});
app.put('/api/chart/analytics/:id', (request, response, next) => {
  try { return response.json({ item: saveAnalytic({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
});
app.post('/api/chart/cost-centers', (request, response, next) => {
  try { return response.status(201).json({ item: saveCostCenterEntry(request.body || {}) }); } catch (error) { return next(error); }
});
app.put('/api/chart/cost-centers/:id', (request, response, next) => {
  try { return response.json({ item: saveCostCenterEntry({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
});
app.get('/api/tax/rates', (_request, response) => response.json({ items: listTaxRates() }));
app.post('/api/tax/rates', (request, response, next) => { try { response.status(201).json({ item: saveTaxRate(request.body) }); } catch (error) { next(error); } });
app.put('/api/tax/rates/:id', (request, response, next) => { try { response.json({ item: saveTaxRate({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
app.get('/api/tax/report', (request, response, next) => { try { response.json(taxReport(request.query)); } catch (error) { next(error); } });
app.get('/api/tax-assistant/sources', (_request, response) => response.json({ items: listTaxKnowledgeSources() }));
app.post('/api/tax-assistant/sources', (request, response, next) => {
  try { return response.status(201).json({ item: saveTaxKnowledgeSource(request.body || {}) }); } catch (error) { return next(error); }
});
app.put('/api/tax-assistant/sources/:id', (request, response, next) => {
  try { return response.json({ item: saveTaxKnowledgeSource({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
});
app.get('/api/tax-assistant/questions', (request, response) => response.json({ items: listTaxAssistantQuestions(request.query) }));
app.post('/api/tax-assistant/questions', (request, response, next) => {
  try { return response.status(201).json({ item: askTaxAssistant(request.body || {}) }); } catch (error) { return next(error); }
});
app.post('/api/tax-assistant/questions/:id/resolve', (request, response, next) => {
  try {
    const item = resolveTaxAssistantQuestion(request.params.id, request.body || {});
    return item ? response.json({ item }) : response.status(404).json({ code: 'TAX_QUESTION_NOT_FOUND', message: 'سؤال پیدا نشد.' });
  } catch (error) { return next(error); }
});
app.get('/api/accounts', (_request, response) => response.json({ items: listAccounts() }));
app.post('/api/accounts', (request, response, next) => { try { response.status(201).json({ item: saveAccount(request.body) }); } catch (error) { next(error); } });
app.put('/api/accounts/:id', (request, response, next) => { try { response.json({ item: saveAccount({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
app.get('/api/transactions', (request, response) => response.json(listTransactions(request.query)));
app.get('/api/transactions/latest', (_request, response) => response.json({ item: latestTransaction() }));
app.put('/api/transactions/:id', (request, response, next) => { try { const item = updateTransaction(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'تراکنش پیدا نشد.' }); } catch (error) { return next(error); } });
app.post('/api/transactions/:id/correct', (request, response, next) => {
  try {
    const current = getTransaction(request.params.id);
    if (!current) return response.status(404).json({ code: 'TRANSACTION_NOT_FOUND', message: 'تراکنش پیدا نشد.' });
    const command = String(request.body?.command || '').trim().slice(0, 500);
    const interpretation = previewCorrection(command, current, { learnings: getLearnings(), accounts: listAccounts(), categories: getCategories() });
    if (!interpretation.canApply) return response.status(400).json({ code: 'CORRECTION_NOT_UNDERSTOOD', message: interpretation.explanation });
    const item = correctLatestTransaction(request.params.id, command, interpretation.changes);
    return response.json({ item, interpretation });
  } catch (error) { return next(error); }
});
app.post('/api/transactions/:id/redo', (request, response, next) => { try { return response.status(201).json({ item: redoTransaction(request.params.id) }); } catch (error) { return next(error); } });
app.delete('/api/transactions/:id', (request, response, next) => { try { return response.status(deleteTransaction(request.params.id) ? 204 : 404).end(); } catch (error) { return next(error); } });
app.get('/api/contacts', (_request, response) => response.json({ items: listContacts() }));
app.post('/api/contacts', (request, response, next) => { try { response.status(201).json({ item: saveContact(request.body) }); } catch (error) { next(error); } });
app.put('/api/contacts/:id', (request, response, next) => { try { response.json({ item: saveContact({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
app.delete('/api/contacts/:id', (request, response) => response.status(deleteContact(request.params.id) ? 204 : 404).end());
app.get('/api/obligations', (request, response) => response.json({ items: listObligations({ status: request.query.status || 'open' }) }));
app.post('/api/obligations', (request, response, next) => { try { response.status(201).json({ item: saveObligation(request.body) }); } catch (error) { next(error); } });
app.put('/api/obligations/:id', (request, response, next) => { try { response.json({ item: saveObligation({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
app.post('/api/obligations/:id/settle', (request, response, next) => { try { const result = settleObligation(request.params.id, request.body); return result ? response.json(result) : response.status(404).json({ message: 'طلب یا بدهی باز پیدا نشد.' }); } catch (error) { return next(error); } });
app.delete('/api/obligations/:id', (request, response) => response.status(deleteObligation(request.params.id) ? 204 : 404).end());
app.get('/api/recurring', (_request, response) => response.json({ items: listRecurringRules() }));
app.post('/api/recurring', (request, response, next) => { try { response.status(201).json({ item: saveRecurringRule(request.body) }); } catch (error) { next(error); } });
app.delete('/api/recurring/:id', (request, response) => response.status(deleteRecurringRule(request.params.id) ? 204 : 404).end());
app.get('/api/invoices', (request, response) => response.json(listInvoices({ status: request.query.status, documentType: request.query.documentType })));
app.get('/api/invoices/:id', (request, response) => { const item = getInvoice(request.params.id); return item ? response.json({ item }) : response.status(404).json({ message: 'فاکتور پیدا نشد.' }); });
app.post('/api/invoices', (request, response, next) => { try { response.status(201).json({ item: createInvoice(request.body) }); } catch (error) { next(error); } });
app.post('/api/invoices/:id/issue', (request, response, next) => { try { const item = issueInvoice(request.params.id, request.body || {}); return item ? response.json({ item }) : response.status(404).json({ message: 'سند پیدا نشد.' }); } catch (error) { return next(error); } });
app.post('/api/invoices/:id/payments', (request, response, next) => { try { const item = recordInvoicePayment(request.params.id, request.body || {}); return item ? response.status(201).json({ item }) : response.status(404).json({ message: 'سند باز پیدا نشد.' }); } catch (error) { return next(error); } });
app.post('/api/invoices/:id/paid', (request, response, next) => { try { const item = markInvoicePaid(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'فاکتور پیدا نشد.' }); } catch (error) { return next(error); } });
app.delete('/api/invoices/:id', (request, response) => response.status(deleteInvoice(request.params.id) ? 204 : 409).end());
app.get('/api/reconciliation/imports', (_request, response) => response.json({ items: listReconciliationImports() }));
app.get('/api/reconciliation/imports/:id', (request, response) => { const item = getReconciliationImport(request.params.id); return item ? response.json({ item }) : response.status(404).json({ message: 'صورت‌حساب پیدا نشد.' }); });
app.post('/api/reconciliation/imports', statementUpload.single('statement'), (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ message: 'فایل CSV صورت‌حساب را انتخاب کن.' });
    if (!/\.csv$/i.test(request.file.originalname || '')) return response.status(400).json({ code: 'STATEMENT_FILE_TYPE', message: 'فقط فایل CSV پذیرفته می‌شود.' });
    const item = importBankStatement({ buffer: request.file.buffer, fileName: request.file.originalname, accountId: request.body?.accountId });
    return response.status(201).json({ item });
  } catch (error) { return next(error); }
});
app.post('/api/reconciliation/lines/:id/match', (request, response, next) => { try { return response.json({ item: matchReconciliationLine(request.params.id, request.body?.transactionId) }); } catch (error) { return next(error); } });
app.post('/api/reconciliation/lines/:id/create', (request, response, next) => { try { const item = createTransactionFromStatementLine(request.params.id, request.body || {}); return item ? response.status(201).json({ item }) : response.status(404).json({ message: 'ردیف باز پیدا نشد.' }); } catch (error) { return next(error); } });
app.post('/api/reconciliation/lines/:id/ignore', (request, response, next) => { try { return response.json({ item: ignoreReconciliationLine(request.params.id, request.body?.reason) }); } catch (error) { return next(error); } });
app.post('/api/reconciliation/imports/:id/close', (request, response, next) => { try { return response.json({ item: closeBankReconciliation(request.params.id) }); } catch (error) { return next(error); } });
app.get('/api/closings', (_request, response) => response.json({ items: listDailyClosings() }));
app.get('/api/closings/preview', (request, response) => response.json({ item: previewDayClosing(request.query) }));
app.post('/api/closings', (request, response, next) => { try { response.status(201).json({ item: closeDay(request.body) }); } catch (error) { next(error); } });
app.get('/api/receipts', (request, response) => response.json({ items: listReceipts({ status: request.query.status }), ocrConfigured: receiptOcrConfigured() }));
app.get('/api/receipts/:id', (request, response) => {
  const item = getReceipt(request.params.id);
  return item ? response.json({ item, candidates: receiptCandidates(item.id) }) : response.status(404).json({ message: 'رسید پیدا نشد.' });
});
app.get('/api/receipts/:id/image', (request, response) => {
  const image = receiptImage(request.params.id);
  if (!image) return response.status(404).end();
  response.setHeader('Content-Type', image.mimeType);
  response.setHeader('Cache-Control', 'private, max-age=3600');
  return response.send(image.imageData);
});
app.post('/api/receipts', upload.single('image'), async (request, response, next) => {
  try {
    if (!request.file || !['image/jpeg', 'image/png', 'image/webp'].includes(request.file.mimetype)) return response.status(400).json({ message: 'یک تصویر JPG، PNG یا WebP انتخاب کن.' });
    const note = String(request.body.note || '');
    const parsed = parseFinancialText(note, { learnings: getLearnings(), averages: typicalAmounts(), source: 'text' });
    const noteSuggestion = parsed.transactions[0] || null;
    let extraction = null;
    let warning = null;
    let usageId = null;
    try {
      if (receiptOcrConfigured()) usageId = beginProviderUsage('receipt_ocr', 'openai');
      extraction = await extractReceiptData({ buffer: request.file.buffer, mimeType: request.file.mimetype, note, categories: getCategories() });
      if (usageId) finishProviderUsage(usageId, { provider: extraction.provider || 'openai' });
    } catch (error) {
      if (usageId) finishProviderUsage(usageId, { provider: error.provider || 'openai', succeeded: false, errorCode: error.code });
      warning = { code: error.code || 'RECEIPT_OCR_FAILED', message: error.message };
    }
    const reviewReasons = [...(extraction?.reviewReasons || [])];
    if (extraction?.amount && noteSuggestion?.amount && extraction.amount !== noteSuggestion.amount) reviewReasons.push('مبلغ تصویر و توضیح کاربر یکسان نیست؛ مبلغ تصویر پیشنهاد شده و باید کنترل شود.');
    if (!extraction && noteSuggestion) reviewReasons.push('مبلغ فقط از توضیح کاربر استخراج شده و با تصویر کنترل نشده است.');
    const amount = extraction?.amount || noteSuggestion?.amount || null;
    const type = noteSuggestion?.type || extraction?.type || null;
    const category = noteSuggestion?.category || extraction?.category || null;
    const accountId = String(request.body.accountId || noteSuggestion?.accountId || 'cash');
    const status = extraction?.status === 'ready' && amount && type && category ? 'ready' : extraction ? 'review' : warning ? 'failed' : 'review';
    const item = saveReceipt({
      buffer: request.file.buffer, fileName: request.file.originalname, mimeType: request.file.mimetype, note, amount, type, category, accountId,
      merchant: extraction?.merchant, occurredAt: extraction?.occurredAt, paymentMethod: extraction?.paymentMethod,
      reference: extraction?.reference, status, ocrProvider: extraction?.provider || (noteSuggestion ? 'note-parser' : ''),
      ocrModel: extraction?.model || '', ocrConfidence: extraction?.confidence || 0, fieldConfidence: extraction?.fieldConfidence || {},
      ocrText: extraction?.rawText || '', reviewReasons,
    });
    return response.status(201).json({ item, suggestion: extraction || noteSuggestion, warning, candidates: receiptCandidates(item.id) });
  } catch (error) { return next(error); }
});
app.put('/api/receipts/:id', (request, response, next) => { try { const item = updateReceipt(request.params.id, request.body || {}); return item ? response.json({ item, candidates: receiptCandidates(item.id) }) : response.status(404).json({ message: 'رسید باز پیدا نشد.' }); } catch (error) { return next(error); } });
app.post('/api/receipts/:id/confirm', (request, response, next) => { try { const item = confirmReceipt(request.params.id, request.body || {}); return item ? response.json({ item }) : response.status(404).json({ message: 'رسید باز پیدا نشد.' }); } catch (error) { return next(error); } });
app.delete('/api/receipts/:id', (request, response) => response.status(deleteReceipt(request.params.id) ? 204 : 404).end());
app.get('/api/automation-rules', (request, response) => response.json({ items: listAutomationRules(request.query.source) }));
app.post('/api/automation-rules', (request, response, next) => { try { return response.status(201).json({ item: saveAutomationRule(request.body || {}) }); } catch (error) { return next(error); } });
app.delete('/api/automation-rules/:id', (request, response) => response.status(deleteAutomationRule(request.params.id) ? 204 : 404).end());
app.get('/api/products', (_request, response) => response.json({ items: listProducts() }));
app.get('/api/inventory/overview', (_request, response) => response.json(inventoryOverview()));
app.post('/api/products', (request, response, next) => { try { response.status(201).json({ item: saveProduct(request.body) }); } catch (error) { next(error); } });
app.put('/api/products/:id', (request, response, next) => { try { response.json({ item: saveProduct({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
app.post('/api/products/:id/stock', (request, response, next) => { try { const item = adjustStock(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'کالا پیدا نشد.' }); } catch (error) { return next(error); } });
app.post('/api/ask', (request, response) => response.json(answerFinancialQuestion(request.body?.question)));
app.get('/api/commercial/status', (request, response) => response.json(commercialStatus(request.workspace.id)));
app.post('/api/commercial/admin/workspaces/:workspaceId', (request, response, next) => {
  try {
    if (!requireSystemAdmin(request, response)) return undefined;
    const workspace = allWorkspaces().find((item) => item.id === request.params.workspaceId);
    if (!workspace) return response.status(404).json({ message: 'دفتر پیدا نشد.' });
    const item = updateWorkspaceCommercialPlan(workspace.id, request.body || {}, request.user.id);
    return response.json({ item });
  } catch (error) { return next(error); }
});
app.get('/api/collaboration/overview', (request, response) => {
  const packageData = monthlyAccountantPackage(request.query.month);
  return response.json({
    package: {
      generatedAt: packageData.generatedAt, scope: packageData.scope, summary: packageData.summary,
      checklist: packageData.checklist, manifest: packageData.manifest, disclaimer: packageData.disclaimer,
    },
    requests: listCollaborationRequests({ status: request.query.status }),
    commercial: commercialStatus(request.workspace.id),
    pilot: pilotWorkspaceDashboard(),
  });
});
app.get('/api/collaboration/monthly-package', (request, response) => response.json(monthlyAccountantPackage(request.query.month)));
app.get('/api/collaboration/monthly-package/download', (request, response) => {
  const packageData = monthlyAccountantPackage(request.query.month);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="hesab-yar-accountant-${request.workspace.id}-${packageData.scope.month}.json"`);
  return response.send(JSON.stringify(packageData, null, 2));
});
app.get('/api/accountant-transfer/overview', (request, response, next) => {
  try { return response.json(accountingTransferOverview(request.query.month, request.query.target)); }
  catch (error) { return next(error); }
});
app.put('/api/accountant-transfer/settings', (request, response, next) => {
  try { return response.json({ item: saveAccountingTransferSettings(request.body || {}) }); }
  catch (error) { return next(error); }
});
app.post('/api/accountant-transfer/template', transferTemplateUpload.single('file'), (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
    return response.status(201).json({
      item: saveAccountingTransferTemplate(request.body?.targetSystem, request.file.buffer, request.file.originalname),
    });
  } catch (error) { return next(error); }
});
app.post('/api/accountant-transfer/mappings/from-chart', (request, response, next) => {
  try {
    return response.json(fillTransferMappingsFromChart(request.body?.targetSystem, { overwrite: request.body?.overwrite === true }));
  } catch (error) { return next(error); }
});
app.put('/api/accountant-transfer/mappings/:ledgerAccountId', (request, response, next) => {
  try {
    const item = saveAccountingTransferMapping({ ...request.body, ledgerAccountId: request.params.ledgerAccountId });
    return response.json({ item });
  } catch (error) { return next(error); }
});
app.get('/api/accountant-transfer/batches', (request, response) => response.json({ items: listAccountingTransferBatches(request.query) }));
app.post('/api/accountant-transfer/batches', (request, response, next) => {
  try { return response.status(201).json({ item: createAccountingTransferBatch(request.body || {}) }); }
  catch (error) { return next(error); }
});
app.get('/api/accountant-transfer/batches/:id/download', (request, response) => {
  response.setHeader('Allow', 'POST');
  return response.status(405).json({
    code: 'TRANSFER_DOWNLOAD_POST_REQUIRED',
    message: 'برای ثبت امن سابقهٔ تحویل، دریافت فایل باید از دکمهٔ داخل حساب‌یار انجام شود.',
  });
});
app.post('/api/accountant-transfer/batches/:id/download', (request, response, next) => {
  try {
    const item = claimAccountingTransferBatchDownload(request.params.id, request.body || {});
    if (!item) return response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
    response.setHeader('Content-Type', item.mimeType || 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${item.fileName}"`);
    response.setHeader('X-Content-SHA256', item.digest);
    response.setHeader('X-HasabYar-Batch-ID', item.id);
    response.setHeader('X-HasabYar-Download-Count', String(item.downloadCount));
    return response.send(item.fileData);
  } catch (error) { return next(error); }
});
app.post('/api/accountant-transfer/batches/:id/status', (request, response, next) => {
  try {
    const item = updateAccountingTransferBatchStatus(request.params.id, request.body || {});
    return item ? response.json({ item }) : response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
  } catch (error) { return next(error); }
});
app.get('/api/accountant-transfer/batches/:id/validations', (request, response) => {
  const batch = accountingTransferBatchFile(request.params.id);
  if (!batch) return response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
  return response.json({ items: listAccountingTransferValidations(request.params.id) });
});
app.post('/api/accountant-transfer/batches/:id/validations', (request, response, next) => {
  try {
    const item = createAccountingTransferValidation(request.params.id, request.body || {});
    return item ? response.status(201).json({ item }) : response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
  } catch (error) { return next(error); }
});
app.post('/api/collaboration/requests', (request, response, next) => {
  try { return response.status(201).json({ item: createCollaborationRequest(request.body || {}) }); }
  catch (error) { return next(error); }
});
app.post('/api/collaboration/requests/:id/answer', (request, response, next) => {
  try {
    const item = answerCollaborationRequest(request.params.id, request.body?.answer);
    return item ? response.json({ item }) : response.status(404).json({ message: 'درخواست باز پیدا نشد.' });
  } catch (error) { return next(error); }
});
app.post('/api/collaboration/requests/:id/resolve', (request, response, next) => {
  try {
    const item = resolveCollaborationRequest(request.params.id);
    return item ? response.json({ item }) : response.status(409).json({ message: 'درخواست باید ابتدا پاسخ داده شود.' });
  } catch (error) { return next(error); }
});
app.post('/api/pilot/checkins', (request, response, next) => {
  try { return response.status(201).json({ item: savePilotCheckin(request.body || {}), dashboard: pilotWorkspaceDashboard() }); }
  catch (error) { return next(error); }
});
app.get('/api/pilot/portfolio', (request, response) => {
  if (!requireSystemAdmin(request, response)) return undefined;
  return response.json(pilotPortfolio());
});
app.get('/api/operations/overview', async (request, response, next) => {
  try {
    const backup = await automaticBackupStatus(request.workspace.id);
    const commercial = commercialStatus(request.workspace.id);
    const signals = workspaceOperationalSignals();
    const ageHours = backup.lastBackup ? (Date.now() - new Date(backup.lastBackup.createdAt).getTime()) / 3_600_000 : null;
    return response.json({
      ...signals,
      backup: { ...backup, ageHours: ageHours == null ? null : Math.round(ageHours), healthy: Boolean(backup.configured && ageHours != null && ageHours <= 30) },
      budget: commercial.provider,
      runbook: 'docs/phase-6-pilot-and-operations.md',
    });
  } catch (error) { return next(error); }
});
app.post('/api/voice/metrics', (request, response) => {
  const provider = String(request.body?.provider || '');
  if (!['browser-live', 'openai-realtime'].includes(provider)) return response.status(400).json({ code: 'VOICE_METRIC_INVALID', message: 'مسیر تشخیص صدا معتبر نیست.' });
  recordVoiceMetric({
    provider,
    model: provider === 'openai-realtime' ? (process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || 'gpt-live-transcribe') : 'web-speech-fa-IR',
    durationMs: Math.min(60_000, Math.max(0, Number(request.body?.durationMs) || 0)),
    firstTranscriptMs: Math.min(60_000, Math.max(0, Number(request.body?.firstTranscriptMs) || 0)),
    latencyMs: Math.min(60_000, Math.max(0, Number(request.body?.latencyMs) || 0)),
    transactionCount: Math.min(20, Math.max(0, Number(request.body?.transactionCount) || 0)),
    needsReview: Boolean(request.body?.needsReview),
  });
  if (provider === 'openai-realtime') recordRealtimeProviderDuration(Math.min(60_000, Math.max(0, Number(request.body?.durationMs) || 0)));
  return response.status(204).end();
});
app.get('/api/voice/status', (_request, response) => response.json(voiceProviderStatus()));
app.get('/api/voice/stats', (_request, response) => response.json(voiceStats()));
app.get('/api/backups/status', async (request, response, next) => {
  try { return response.json(await automaticBackupStatus(request.workspace.id)); }
  catch (error) { return next(error); }
});
app.post('/api/backups/export', (request, response, next) => {
  try {
    const encrypted = createPortableBackup(request.workspace, request.body?.passphrase);
    response.setHeader('Content-Disposition', `attachment; filename="hesab-yar-${request.workspace.id}-${new Date().toISOString().slice(0, 10)}.hybackup"`);
    response.setHeader('Content-Type', 'application/octet-stream');
    return response.send(encrypted);
  } catch (error) { return next(error); }
});
app.post('/api/backups/preview', backupUpload.single('backup'), (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ code: 'BACKUP_MISSING', message: 'فایل پشتیبان را انتخاب کن.' });
    return response.json({ summary: backupSummary(openEncryptedBackup(request.file.buffer, request.body?.passphrase)) });
  } catch (error) { return next(error); }
});
app.post('/api/backups/restore', backupUpload.single('backup'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ code: 'BACKUP_MISSING', message: 'فایل پشتیبان را انتخاب کن.' });
    if (String(request.body?.confirmation || '').trim() !== 'بازیابی دفتر') return response.status(400).json({ code: 'RESTORE_CONFIRMATION_REQUIRED', message: 'برای تأیید، عبارت «بازیابی دفتر» را دقیق بنویس.' });
    const result = await restorePortableBackup(request.file.buffer, request.body?.passphrase, request.workspace);
    revokeWorkspaceSessions(request.workspace.id, request.user.id);
    return response.json(result);
  } catch (error) { return next(error); }
});
app.post('/api/backups/snapshot', async (request, response, next) => {
  try {
    if (!automaticBackupConfigured()) return response.status(503).json({ code: 'BACKUP_NOT_CONFIGURED', message: 'ابتدا BACKUP_ENCRYPTION_KEY را روی سرور تنظیم کن.' });
    return response.status(201).json({ backup: await writeServerBackup(request.workspace, { reason: 'manual' }) });
  } catch (error) { return next(error); }
});
app.get('/api/learnings', (_request, response) => response.json({ items: getLearnings() }));
app.post('/api/learnings', (request, response, next) => { try { response.status(201).json({ item: saveLearning(request.body || {}) }); } catch (error) { next(error); } });
app.put('/api/learnings/:id', (request, response, next) => { try { const item = updateLearning(request.params.id, request.body || {}); if (!item) return response.status(404).json({ message: 'یادگیری پیدا نشد.' }); return response.json({ item }); } catch (error) { return next(error); } });
app.delete('/api/learnings/:id', (request, response) => response.status(deleteLearning(request.params.id) ? 204 : 404).end());
app.patch('/api/settings', (request, response) => response.json({ settings: saveSettings(request.body || {}) }));

app.use('/api', (_request, response) => response.status(404).json({ code: 'API_NOT_FOUND', message: 'مسیر درخواستی پیدا نشد.' }));

const dist = resolve('dist');
if (existsSync(dist)) {
  // فایل‌های داخل assets نام هش‌دار دارند و محتوایشان هرگز عوض نمی‌شود، پس
  // می‌توانند یک سال کش شوند.
  app.use('/assets', express.static(resolve(dist, 'assets'), {
    maxAge: '1y', immutable: true, etag: true, index: false,
  }));
  // بقیهٔ فایل‌ها نام ثابت دارند. اگر index.html یا sw.js کش شوند، دیپلوی تازه
  // تا پایان عمر کش برای مرورگر کاربر نامرئی می‌ماند و کاربر مجبور می‌شود
  // Ctrl+Shift+R بزند. no-cache یعنی «هر بار بپرس»، نه «کش نکن»؛ با ETag
  // پاسخ معمولاً یک 304 کوتاه است.
  const alwaysRevalidate = /(?:index\.html|sw\.js|manifest\.webmanifest)$/;
  app.use(express.static(dist, {
    etag: true,
    index: false,
    setHeaders(response, filePath) {
      response.setHeader('Cache-Control', alwaysRevalidate.test(filePath) ? 'no-cache' : 'public, max-age=3600');
    },
  }));
  // HEAD هم باید پوستهٔ برنامه را بگیرد؛ مانیتورینگ و بعضی proxyها با HEAD
  // سلامت مسیر را می‌سنجند و ۴۰۴ گرفتنشان یعنی هشدار اشتباه.
  app.use((request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    response.setHeader('Cache-Control', 'no-cache');
    return response.sendFile(resolve(dist, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return response.status(413).json({ code: 'UPLOAD_TOO_LARGE', message: 'فایل انتخاب‌شده بیش از سقف مجاز است.' });
    return response.status(400).json({ code: 'UPLOAD_INVALID', message: 'فایل بارگذاری‌شده معتبر نیست.' });
  }
  console.error(error);
  if (error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds));
  return response.status(error.status || 500).json({
    code: error.code || 'SERVER_ERROR',
    message: error.status ? error.message : 'خطای داخلی سرور؛ دوباره تلاش کن.',
    ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.provider ? { provider: error.provider } : {}),
    ...(error.requiresAction ? { requiresAction: true } : {}),
    ...(error.details ? { details: error.details } : {}),
  });
});

function runRecurringJob() {
  try {
    for (const workspace of allWorkspaces()) runInWorkspace(workspace.id, { role: 'owner' }, () => materializeRecurringRules());
  }
  catch (error) { console.error('Recurring materialization failed:', error); }
}

runRecurringJob();
const recurringTimer = setInterval(runRecurringJob, 60_000);
recurringTimer.unref();

async function runBackupJob() {
  if (!automaticBackupConfigured()) return;
  for (const workspace of allWorkspaces()) {
    try {
      const status = await automaticBackupStatus(workspace.id);
      const stale = !status.lastBackup || Date.now() - new Date(status.lastBackup.createdAt).getTime() >= 20 * 60 * 60 * 1000;
      if (stale) await runInWorkspace(workspace.id, { role: 'owner' }, () => writeServerBackup(workspace));
    } catch (error) { console.error(`Backup failed for workspace ${workspace.id}:`, error); }
  }
}

void runBackupJob();
const backupTimer = setInterval(runBackupJob, 6 * 60 * 60 * 1000);
backupTimer.unref();

// سرور export می‌شود تا تست بتواند بعد از پایان کار ببنددش و فرایند معلق نماند.
export const server = app.listen(port, '0.0.0.0', () => console.log(`HesabYar API listening on http://localhost:${port}`));
export { app };
