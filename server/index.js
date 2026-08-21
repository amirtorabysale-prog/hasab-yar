import 'node:process';
import express from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  adjustStock, answerFinancialQuestion, authenticateUser, closeDay, createInvoice, createSession, deleteContact,
  deleteInvoice, deleteLearning, deleteObligation, deleteRecurringRule, deleteSession, deleteTransaction,
  ensureAdmin, exportSnapshot, financialOverview, getCategories, getInvoice, getLearnings, getSettings,
  getToday, insertTransactions, listContacts, listDailyClosings, listInvoices, listObligations, listProducts,
  listReceipts, listRecurringRules, listTransactions, markInvoicePaid, materializeRecurringRules, receiptImage, recordVoiceMetric,
  report, saveContact, saveLearning, saveObligation, saveRecurringRule, saveSettings, settleObligation,
  saveProduct, saveReceipt, typicalAmounts, updateLearning, updateTransaction, userFromSession, voiceStats,
} from './db.js';
import { inferLearningKeyword, parseFinancialText } from './parser.js';
import { parseFinancialAudio } from './voice.js';

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

app.get('/api/health', (_request, response) => response.json({ ok: true, voicePipeline: 'openai-transcribe+deterministic-parser+gemini-fallback-v2' }));
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
app.get('/api/bootstrap', (_request, response) => {
  materializeRecurringRules();
  return response.json({
    ...getToday(), categories: getCategories(), settings: getSettings(), learnings: getLearnings(),
    averages: typicalAmounts(), overview: financialOverview(), contacts: listContacts(),
    obligations: listObligations({ status: 'open' }), recurring: listRecurringRules(),
  });
});
app.post('/api/parse/text', (request, response) => {
  const text = String(request.body?.text || '').trim();
  if (!text || text.length > 1500) return response.status(400).json({ message: 'متن ثبت مالی معتبر نیست.' });
  return response.json(parseFinancialText(text, { learnings: getLearnings(), averages: typicalAmounts() }));
});
app.post('/api/parse/audio', upload.single('audio'), async (request, response, next) => {
  const startedAt = Date.now();
  try {
    if (!request.file) return response.status(400).json({ message: 'فایل صدا دریافت نشد.' });
    const result = await parseFinancialAudio({ buffer: request.file.buffer, mimeType: request.file.mimetype || 'application/octet-stream', hint: request.body?.hint, categories: getCategories(), learnings: getLearnings(), averages: typicalAmounts() });
    recordVoiceMetric({ provider: result.provider || result.engine, model: result.model, latencyMs: Date.now() - startedAt, transactionCount: result.transactions?.length, needsReview: result.transactions?.some((item) => item.needsReview) });
    return response.json(result);
  } catch (error) {
    recordVoiceMetric({ provider: 'pipeline', latencyMs: Date.now() - startedAt, succeeded: false, errorCode: error.code });
    return next(error);
  }
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
app.get('/api/overview', (_request, response) => response.json(financialOverview()));
app.get('/api/transactions', (request, response) => response.json(listTransactions(request.query)));
app.put('/api/transactions/:id', (request, response, next) => { try { const item = updateTransaction(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'تراکنش پیدا نشد.' }); } catch (error) { return next(error); } });
app.delete('/api/transactions/:id', (request, response) => response.status(deleteTransaction(request.params.id) ? 204 : 404).end());
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
app.get('/api/invoices', (_request, response) => response.json({ items: listInvoices() }));
app.get('/api/invoices/:id', (request, response) => { const item = getInvoice(request.params.id); return item ? response.json({ item }) : response.status(404).json({ message: 'فاکتور پیدا نشد.' }); });
app.post('/api/invoices', (request, response, next) => { try { response.status(201).json({ item: createInvoice(request.body) }); } catch (error) { next(error); } });
app.post('/api/invoices/:id/paid', (request, response) => { const item = markInvoicePaid(request.params.id); return item ? response.json({ item }) : response.status(404).json({ message: 'فاکتور پیدا نشد.' }); });
app.delete('/api/invoices/:id', (request, response) => response.status(deleteInvoice(request.params.id) ? 204 : 409).end());
app.get('/api/closings', (_request, response) => response.json({ items: listDailyClosings() }));
app.post('/api/closings', (request, response, next) => { try { response.status(201).json({ item: closeDay(request.body) }); } catch (error) { next(error); } });
app.get('/api/receipts', (_request, response) => response.json({ items: listReceipts() }));
app.get('/api/receipts/:id/image', (request, response) => {
  const image = receiptImage(request.params.id);
  if (!image) return response.status(404).end();
  response.setHeader('Content-Type', image.mimeType);
  response.setHeader('Cache-Control', 'private, max-age=3600');
  return response.send(image.imageData);
});
app.post('/api/receipts', upload.single('image'), (request, response, next) => {
  try {
    if (!request.file || !['image/jpeg', 'image/png', 'image/webp'].includes(request.file.mimetype)) return response.status(400).json({ message: 'یک تصویر JPG، PNG یا WebP انتخاب کن.' });
    const parsed = parseFinancialText(String(request.body.note || ''), { learnings: getLearnings(), averages: typicalAmounts(), source: 'text' });
    const first = parsed.transactions[0];
    const item = saveReceipt({ buffer: request.file.buffer, fileName: request.file.originalname, mimeType: request.file.mimetype, note: request.body.note, amount: first?.amount, type: first?.type, category: first?.category });
    return response.status(201).json({ item, suggestion: first || null });
  } catch (error) { return next(error); }
});
app.get('/api/products', (_request, response) => response.json({ items: listProducts() }));
app.post('/api/products', (request, response, next) => { try { response.status(201).json({ item: saveProduct(request.body) }); } catch (error) { next(error); } });
app.put('/api/products/:id', (request, response, next) => { try { response.json({ item: saveProduct({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
app.post('/api/products/:id/stock', (request, response, next) => { try { const item = adjustStock(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'کالا پیدا نشد.' }); } catch (error) { return next(error); } });
app.post('/api/ask', (request, response) => response.json(answerFinancialQuestion(request.body?.question)));
app.get('/api/voice/stats', (_request, response) => response.json(voiceStats()));
app.get('/api/export', (_request, response) => {
  response.setHeader('Content-Disposition', `attachment; filename="hesab-yar-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  return response.json(exportSnapshot());
});
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
