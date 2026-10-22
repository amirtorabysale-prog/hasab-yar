import 'node:process';
import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activeWorkspaces, allWorkspaces, authenticateUser, clearLoginFailures, createSession, ensureAdmin, loginThrottle, materializeRecurringRules, recordLoginFailure, runRecognition, runInWorkspace, userFromSession, workspaceForUser, approvalModeFor,
} from './db.js';
import { minimumRoleForRequest } from './access.js';
import { EXPERIENCES, experienceForRole, pathNeedsProfessional } from '../shared/experience.js';
import { readOverdraftApproval } from './balanceGuard.js';
import { automaticBackupConfigured, automaticBackupStatus, writeServerBackup } from './backup.js';
import {
  accountLoginFingerprint, csrfTokenFor, csrfTokenIsValid, originMatchesHost, requestFingerprint, setSecurityHeaders, validateSecurityConfiguration,
} from './security.js';
import { healthPayload } from './release.js';
import { topicPromotionSweep } from './topicPromotion.js';
import { db as activeDb, currentTimeZone } from './db/core.js';
import { cookies, sessionCookie, workspaceCookie, accessPayload, requireRank } from './routes/http.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerHomeRoutes } from './routes/home.js';
import { registerCaptureRoutes } from './routes/capture.js';
import { registerUnderstandingRoutes } from './routes/understanding.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerAccountingRoutes } from './routes/accounting.js';
import { registerChartRoutes } from './routes/chart.js';
import { registerTreasuryRoutes } from './routes/treasury.js';
import { registerTaxAndPayrollRoutes } from './routes/taxAndPayroll.js';
import { registerTransferRoutes } from './routes/transfer.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerSystemRoutes } from './routes/system.js';

const app = express();
const port = Number(process.env.PORT || 4173);
const securityConfig = validateSecurityConfiguration();
const adminState = ensureAdmin();
if (securityConfig.production) app.set('trust proxy', securityConfig.trustProxyHops);

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
  // کوکیِ دفتری که بایگانی شده، کاربر را قفل نمی‌کند؛ به دفتر فعال بعدی برمی‌گردد.
  // درخواست صریح (هدر) به دفتر بایگانی‌شده همچنان رد می‌شود.
  const workspace = workspaceForUser(user.id, requestedWorkspace)
    || (!request.get('x-workspace-id') && requestedWorkspace === cookies(request).hy_workspace ? workspaceForUser(user.id) : null);
  if (!workspace) return response.status(403).json({ code: 'WORKSPACE_FORBIDDEN', message: 'به این دفتر دسترسی نداری.' });
  request.workspace = workspace;
  response.append('Set-Cookie', workspaceCookie(workspace.id));
  // تأیید حسابدار برای منفی شدن موجودی، فروش بیش از انبار و اصلاح سند صادرشده.
  // دفتری که تأییدکنندهٔ دیگری دارد، تأییدِ ثبت‌کننده برای کار خودش را نمی‌پذیرد
  // (تأیید دونفره)؛ آن‌جا فقط درخواستِ تأییدشده در صف (`X-Approval-Request-Id`) اجرا می‌شود.
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const approvalMode = mutating ? approvalModeFor(workspace.id, user.id, workspace.role) : 'inline';
  const overdraftApproval = approvalMode === 'inline'
    ? readOverdraftApproval(request.get('x-overdraft-approval'), { role: workspace.role, userId: user.id }) : null;
  const approvalRequestId = String(request.get('x-approval-request-id') || '').trim().slice(0, 64) || null;
  // هشدار «شاید تکراری» را کاربر دیده و ثبت را خواسته (`duplicateGuard.js`).
  const allowDuplicate = mutating && request.get('x-allow-duplicate') === '1';
  return runInWorkspace(workspace.id, {
    ...workspace, userId: user.id, overdraftApproval, approvalMode, approvalRequestId, allowDuplicate,
    requestMethod: request.method, requestPath: `${request.baseUrl}${request.path}`, requestBody: request.body,
  }, next);
});
app.use('/api', (request, response, next) => {
  const path = request.path;
  if (request.user.mustChangePassword && !['/auth/password', '/auth/logout'].includes(path)) {
    return response.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'پیش از ادامه رمز موقت را تغییر بده.' });
  }
  const minimum = minimumRoleForRequest(request.method, path);
  if (!requireRank(request, response, minimum)) return undefined;
  // مرز تجربه در سرور هم اعمال می‌شود.
  //
  // مخفی‌کردن منو امنیت نیست: کسی که آدرس را بداند همچنان صدا می‌زند. و کنترل
  // رتبه‌ای اینجا کمکی نمی‌کند، چون صاحب کسب‌وکار بالاترین رتبه را دارد و از
  // همهٔ کنترل‌های رتبه‌ای رد می‌شود.
  const experience = experienceForRole(request.workspace?.role, request.workspace?.experiencePreference);
  if (experience !== EXPERIENCES.PROFESSIONAL && pathNeedsProfessional(path)) {
    return response.status(403).json({
      code: 'EXPERIENCE_FORBIDDEN',
      message: 'این بخش ابزار حسابدار است و در محیط سادهٔ کسب‌وکار در دسترس نیست.',
    });
  }
  return next();
});
// مسیرهای هر بخش در server/routes/؛ ترتیب ثبت همان ترتیب پیشین در همین فایل است.
registerAccountRoutes(app);
registerHomeRoutes(app);
registerCaptureRoutes(app);
registerUnderstandingRoutes(app);
registerReviewRoutes(app);
registerAccountingRoutes(app);
registerChartRoutes(app);
registerTreasuryRoutes(app);
registerTaxAndPayrollRoutes(app);
registerTransferRoutes(app);
registerLedgerRoutes(app);
registerSystemRoutes(app);

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
    // سؤالی که ثبت را نگه داشته (دورهٔ پوشش، کدام قرارداد، پایان یا ادامه) و
    // نامزدهایش، تا رابط همان را بپرسد نه پیام خام را.
    ...(error.question ? { question: error.question } : {}),
    ...(error.candidates ? { candidates: error.candidates } : {}),
  });
});

/**
 * کار دقیقه‌ای دفتر: قاعده‌های تکرارشونده و شناسایی ماهانهٔ پیش‌پرداخت و درآمد
 * انتقالی.
 *
 * شناسایی تا امروز فقط یک مسیر HTTP داشت که هیچ صفحه‌ای صدایش نمی‌زد؛ یعنی
 * پیش‌پرداخت تا ابد دارایی و درآمد انتقالی تا ابد بدهی می‌ماند. اجرای خودکار
 * حدس نیست: هر رویداد وقتی ثبت شده که کاربر یا حسابدار تأییدش کرده، اجرا فقط
 * قلمِ سررسیدرسیدهٔ رویداد ثبت‌شده را می‌زند، تکرارش سند دوم نمی‌سازد و در دورهٔ
 * بسته چیزی نمی‌نشاند. هر دفتر جدا: خطای یکی، بقیه را نگه نمی‌دارد. دفتر بایگانی‌شده
 * اجرا نمی‌شود؛ داده‌اش همان می‌ماند که هنگام بستن بود.
 */
function runRecurringJob() {
  let workspaces = [];
  try { workspaces = activeWorkspaces(); }
  catch (error) { console.error('Recurring job could not list workspaces:', error); return; }
  for (const workspace of workspaces) {
    try { runInWorkspace(workspace.id, { role: 'owner' }, () => materializeRecurringRules()); }
    catch (error) { console.error(`Recurring materialization failed for workspace ${workspace.id}:`, error); }
    try { runInWorkspace(workspace.id, { role: 'owner' }, () => runRecognition()); }
    catch (error) { console.error(`Recognition run failed for workspace ${workspace.id}:`, error); }
    // پیشنهاد ارتقای برچسب: هر ده دقیقه بس است؛ هر برچسب فقط یک بار پرسیده می‌شود.
    if (Date.now() - (lastTopicSweep.get(workspace.id) || 0) >= TOPIC_SWEEP_EVERY_MS) {
      lastTopicSweep.set(workspace.id, Date.now());
      try { runInWorkspace(workspace.id, { role: 'owner' }, () => topicPromotionSweep(activeDb, { timeZone: currentTimeZone() })); }
      catch (error) { console.error(`Topic promotion sweep failed for workspace ${workspace.id}:`, error); }
    }
  }
}
const TOPIC_SWEEP_EVERY_MS = 10 * 60_000;
const lastTopicSweep = new Map();

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
export const server = app.listen(port, '0.0.0.0', () => console.log(`HesabYar API listening on port ${server.address().port}`));
export { app };
