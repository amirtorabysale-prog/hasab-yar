import 'node:process';
import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  authenticateUser, createSession, deleteLearning, deleteSession, ensureAdmin, getCategories,
  getLearnings, getSettings, getToday, insertTransactions, report, saveLearning, saveSettings,
  typicalAmounts, updateLearning, userFromSession,
} from './db.js';
import { inferLearningKeyword, parseFinancialText } from './parser.js';
import { parseAudioWithGemini } from './gemini.js';

const app = express();
const port = Number(process.env.PORT || 4173);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const adminState = ensureAdmin();
const loginAttempts = new Map();

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function sessionCookie(token, maxAge = 30 * 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `hy_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_request, response) => response.json({ ok: true }));
app.get('/api/auth/status', (request, response) => {
  if (!adminState.configured) return response.status(503).json({ code: 'ADMIN_NOT_CONFIGURED', message: 'رمز مالک روی سرور تنظیم نشده است.' });
  const user = userFromSession(cookies(request).hy_session);
  return response.json({ authenticated: Boolean(user), user: user ? { username: user.username } : null });
});
app.post('/api/auth/login', (request, response) => {
  if (!adminState.configured) return response.status(503).json({ code: 'ADMIN_NOT_CONFIGURED', message: 'ابتدا ADMIN_PASSWORD را روی سرور تنظیم کن.' });
  const key = request.ip || request.socket.remoteAddress || 'unknown';
  const cutoff = Date.now() - 15 * 60 * 1000;
  const attempts = (loginAttempts.get(key) || []).filter((time) => time > cutoff);
  if (attempts.length >= 8) return response.status(429).json({ code: 'LOGIN_RATE_LIMIT', message: 'تلاش‌های ورود زیاد بود؛ پانزده دقیقه بعد دوباره امتحان کن.' });
  const user = authenticateUser(request.body?.username, request.body?.password);
  if (!user) { attempts.push(Date.now()); loginAttempts.set(key, attempts); return response.status(401).json({ code: 'INVALID_LOGIN', message: 'نام کاربری یا رمز درست نیست.' }); }
  loginAttempts.delete(key);
  const session = createSession(user.id);
  response.setHeader('Set-Cookie', sessionCookie(session.token));
  return response.json({ authenticated: true, user: { username: user.username } });
});
app.post('/api/auth/logout', (request, response) => {
  deleteSession(cookies(request).hy_session);
  response.setHeader('Set-Cookie', sessionCookie('', 0));
  return response.status(204).end();
});
app.use('/api', (request, response, next) => {
  const user = userFromSession(cookies(request).hy_session);
  if (!user) return response.status(401).json({ code: 'AUTH_REQUIRED', message: 'برای دیدن اطلاعات مالی وارد حساب شو.' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin) {
    try { if (new URL(request.headers.origin).host !== request.get('host')) return response.status(403).json({ code: 'INVALID_ORIGIN', message: 'درخواست نامعتبر است.' }); }
    catch { return response.status(403).json({ code: 'INVALID_ORIGIN', message: 'درخواست نامعتبر است.' }); }
  }
  request.user = user;
  return next();
});
app.get('/api/bootstrap', (_request, response) => response.json({
  ...getToday(),
  categories: getCategories(),
  settings: getSettings(),
  learnings: getLearnings(),
  averages: typicalAmounts(),
}));
app.post('/api/parse/text', (request, response) => {
  const text = String(request.body?.text || '').trim();
  if (!text || text.length > 1500) return response.status(400).json({ message: 'متن ثبت مالی معتبر نیست.' });
  return response.json(parseFinancialText(text, { learnings: getLearnings(), averages: typicalAmounts() }));
});
app.post('/api/parse/audio', upload.single('audio'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ message: 'فایل صدا دریافت نشد.' });
    const result = await parseAudioWithGemini({ buffer: request.file.buffer, mimeType: request.file.mimetype || 'audio/webm', categories: getCategories(), learnings: getLearnings(), averages: typicalAmounts() });
    return response.json(result);
  } catch (error) { return next(error); }
});
app.post('/api/transactions', (request, response, next) => {
  try {
    const transactions = request.body?.transactions;
    if (!Array.isArray(transactions) || !transactions.length || transactions.length > 20) return response.status(400).json({ message: 'حداقل یک تراکنش معتبر لازم است.' });
    const ids = insertTransactions({ transcript: request.body.transcript, transactions });
    for (const item of transactions) {
      if (item.originalCategory && item.originalCategory !== item.category) {
        const keyword = inferLearningKeyword(item.rawText || request.body.transcript);
        if (keyword.length >= 2) saveLearning({ keyword, category: item.category });
      }
    }
    return response.status(201).json({ ids, ...getToday() });
  } catch (error) { return next(error); }
});
app.get('/api/reports', (request, response) => response.json(report(['week', 'month', 'quarter'].includes(request.query.range) ? request.query.range : 'month')));
app.get('/api/learnings', (_request, response) => response.json({ items: getLearnings() }));
app.post('/api/learnings', (request, response, next) => { try { response.status(201).json({ item: saveLearning(request.body || {}) }); } catch (error) { next(error); } });
app.put('/api/learnings/:id', (request, response, next) => { try { const item = updateLearning(request.params.id, request.body || {}); if (!item) return response.status(404).json({ message: 'یادگیری پیدا نشد.' }); return response.json({ item }); } catch (error) { return next(error); } });
app.delete('/api/learnings/:id', (request, response) => response.status(deleteLearning(request.params.id) ? 204 : 404).end());
app.patch('/api/settings', (request, response) => response.json({ settings: saveSettings(request.body || {}) }));

const dist = resolve('dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', etag: true }));
  app.use((request, response, next) => request.method === 'GET' ? response.sendFile(resolve(dist, 'index.html')) : next());
}

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ code: 'AUDIO_TOO_LARGE', message: 'فایل صدا بیش از حد بزرگ است.' });
  console.error(error);
  return response.status(error.status || 500).json({ code: error.code || 'SERVER_ERROR', message: error.status ? error.message : 'خطای داخلی سرور؛ دوباره تلاش کن.' });
});

app.listen(port, '0.0.0.0', () => console.log(`HesabYar API listening on http://localhost:${port}`));
