import { randomUUID } from 'node:crypto';
import { audit, currentWorkspace, db, invalidInput } from './core.js';
import { listAccounts } from './accounts.js';
import { hasCompositeAmounts, parseFinancialText } from '../../shared/parser.js';
import { needsUnquantifiedReview } from '../../shared/reviewIntake.js';
import { detectCaptureTransfer, detectPettyCashFunding } from '../../shared/bankSpeech.js';
import { detectPartnerPaidDebt } from '../../shared/partnerPaidSpeech.js';
import { detectSettleIntent } from '../../shared/settleSpeech.js';
import { detectVoiceIntent } from '../../shared/voiceIntent.js';
import { natureNeedsAccountant, readEventNature, readExplicitNonCash, readNonCashInstrument } from '../../shared/eventNature.js';
import { normalizePersian } from '../../shared/normalize.js';
import { normalizeTopicLabel, topicLabelKey } from '../chartOfAccounts.js';

/**
 * پارسر از AI یاد می‌گیرد — خواستهٔ مالک محصول (۲۹ مهر ۱۴۰۵).
 *
 * هر پروندهٔ فهمِ AI که ثبت می‌شود، همان گفته از مسیر قطعی (پارسر) هم گذرانده می‌شود،
 * بی‌آنکه چیزی ثبت شود. اگر پارسر همان را می‌گفت، درسی نیست. اگر فرق داشت:
 *
 * ۱. **درس دسته** — جهت پول یکی است و فقط دسته فرق دارد، و موضوعِ فهم‌شده («کلید برق»)
 *    در خود جمله هست. بار اول فقط دیده می‌شود؛ بعد از «آستانه» تأییدِ هم‌جهت (پیش‌فرض ۲)
 *    به «آنچه یاد گرفته‌ام» می‌رود با منشأ 'ai'. یادگیریِ AI فقط دسته را عوض می‌کند، هرگز
 *    جهت پول را؛ و یادگیریِ خودِ کاربر را هرگز بی‌صدا بازنویسی نمی‌کند.
 * ۲. **اختلاف ساختاری** — جهت برعکس، ردیف نقدی برای پولی که هنوز نرفته، پولِ جیبِ شریک،
 *    انتقال یا تسویه‌ای که پارسر درآمد/هزینه می‌خواند، یا مبلغ دیگر. این‌ها قاعدهٔ زبان‌اند،
 *    نه عادتِ یک دفتر؛ هرگز خودکار یاد گرفته نمی‌شوند و برای بازبینی و گزارش می‌مانند.
 *
 * پارسری که کارت یا صف را باز می‌کرد (تسویه، چک، گفتهٔ مرکب، …) چیزی را غلط ثبت نمی‌کرد؛
 * از آن درسی گرفته نمی‌شود.
 */

const THRESHOLD_KEY = 'ai_lesson_threshold';
const THRESHOLD_DEFAULT = 2;
const THRESHOLD_MIN = 2;
const THRESHOLD_MAX = 5;
const KINDS = ['category', 'structural'];
const STATUSES = ['watching', 'learned', 'conflict', 'dismissed', 'open', 'reviewed'];
/** دستهٔ عمومی یعنی «دستهٔ خاصی ندیدم»؛ یاد گرفتنش فقط دانستهٔ پارسر را پاک می‌کرد. */
const GENERIC_CATEGORIES = new Set(['سایر هزینه‌ها', 'سایر درآمدها']);
/** موضوعی که فقط از این واژه‌ها ساخته شده، چیزی دربارهٔ دسته نمی‌گوید. */
const GENERIC_WORDS = new Set([
  'پول', 'جنس', 'اجناس', 'کالا', 'کالاها', 'چیز', 'چیزی', 'وسیله', 'وسایل', 'کار', 'خدمت', 'خدمات', 'خرید', 'فروش', 'هزینه',
  'درآمد', 'پرداخت', 'دریافت', 'مبلغ', 'بابت', 'برای', 'از', 'به', 'و', 'رو', 'را', 'یه', 'یک', 'این', 'اون', 'همون', 'مورد',
]);

export const STRUCTURAL_FLAGS = Object.freeze({
  direction: 'جهت پول برعکس خوانده می‌شد',
  'cash-for-unpaid': 'برای پولی که هنوز پرداخت نشده ردیف نقدی می‌ساخت',
  'unpaid-for-paid': 'پولی را که رفته بود پرداخت‌نشده می‌خواند',
  'paid-by-other': 'پول از جیب شریک یا کارمند رفته بود، نه از صندوق و بانک',
  'transfer-as-row': 'انتقال بین حساب‌های خود شرکت را درآمد یا هزینه می‌خواند',
  'settlement-as-row': 'تسویهٔ طلب یا بدهی را درآمد یا هزینهٔ تازه می‌خواند',
  amount: 'مبلغ دیگری می‌خواند',
  'category-unlearnable': 'دسته فرق داشت ولی موضوعی برای یادگیری در جمله نبود',
});

export function ensureAiLessonSchema(database = db) {
  database.exec(`CREATE TABLE IF NOT EXISTS ai_lessons (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN (${KINDS.map((item) => `'${item}'`).join(',')})),
      lesson_key TEXT NOT NULL UNIQUE,
      keyword TEXT,
      category TEXT,
      parser_category TEXT,
      flags TEXT NOT NULL DEFAULT '[]',
      confirmations INTEGER NOT NULL DEFAULT 1,
      case_ids TEXT NOT NULL DEFAULT '[]',
      sample TEXT NOT NULL DEFAULT '',
      parser TEXT NOT NULL DEFAULT '{}',
      final TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN (${STATUSES.map((item) => `'${item}'`).join(',')})),
      learning_id TEXT,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_lessons_status ON ai_lessons(kind,status,updated_at);`);
  return database;
}

const json = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const lessonError = (message, code = 'AI_LESSON_INVALID', status = 400) => Object.assign(new Error(message), { code, status });

export function aiLessonThreshold(database = db) {
  const value = Number(database.prepare('SELECT value FROM settings WHERE key=?').get(THRESHOLD_KEY)?.value);
  return Number.isSafeInteger(value) && value >= THRESHOLD_MIN && value <= THRESHOLD_MAX ? value : THRESHOLD_DEFAULT;
}

export function saveAiLessonThreshold(value) {
  const threshold = Number(value);
  if (!Number.isSafeInteger(threshold) || threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX) {
    throw invalidInput('تعداد تأیید باید عددی بین ۲ تا ۵ باشد.');
  }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(THRESHOLD_KEY, String(threshold));
  audit('save', 'ai_lesson_threshold', THRESHOLD_KEY, { threshold });
  // درس‌هایی که با آستانهٔ تازه به حد رسیده‌اند همین حالا یاد گرفته می‌شوند.
  ensureAiLessonSchema();
  for (const row of db.prepare("SELECT * FROM ai_lessons WHERE kind='category' AND status='watching' AND confirmations>=?").all(threshold)) maybeLearn(row.id);
  return threshold;
}

// ---------------------------------------------------------------------------
// مسیر قطعی: همان ترتیبِ `routeIntent` در src/App.jsx، بدون AI و بدون ثبت
// ---------------------------------------------------------------------------

/**
 * پارسر با این گفته چه می‌کرد؟ `parser` یعنی ردیفِ ساده می‌ساخت؛ `card` و `queue` یعنی
 * کارت می‌پرسید یا به حسابدار می‌فرستاد — هیچ‌کدام ثبتِ غلط نیست.
 */
export function deterministicView(text, { learnings = [], accounts = [], now = new Date() } = {}) {
  if (detectPettyCashFunding(text, { accounts, now })) return { path: 'card', reason: 'petty-cash' };
  if (detectPartnerPaidDebt(text, { now })) return { path: 'card', reason: 'partner-paid' };
  if (needsUnquantifiedReview(text)) return { path: 'queue', reason: 'unquantified' };
  if (hasCompositeAmounts(text)) return { path: 'queue', reason: 'composite' };
  if (detectCaptureTransfer(text, { accounts, now })) return { path: 'card', reason: 'transfer' };
  if (detectSettleIntent(text, { now })) return { path: 'card', reason: 'settle' };
  const intent = detectVoiceIntent(text, { now });
  if (intent) return { path: 'card', reason: `intent:${intent.intent}` };
  // همان کاری که `insertTransactionRows` می‌کند: اصلاحِ ثبت قبلی و چکِ وصول‌نشده ردیف نقدی نمی‌سازند.
  if (natureNeedsAccountant(readEventNature(text)) || readNonCashInstrument(text) || readExplicitNonCash(text)) return { path: 'queue', reason: 'non-cash' };
  const rows = (parseFinancialText(text, { learnings, source: 'text', now }).transactions || [])
    .filter((row) => Number.isSafeInteger(row.amount) && row.amount > 0)
    // ردیفِ پرداخت‌نشده («قراره تا آبان پرداختش کنیم») تعهد باز می‌کند، نه ردیف نقدی.
    .map((row) => ({ amount: row.amount, type: row.type, category: row.category, unpaid: row.unpaidSignal === true }));
  return { path: 'parser', rows };
}

const currentLearnings = () => db.prepare('SELECT id,keyword,category,source FROM learnings ORDER BY updated_at DESC').all();
function currentAccounts() { try { return listAccounts(); } catch { return []; } }

/** واژه‌ای که پارسر می‌تواند با آن دسته را بشناسد: موضوعِ همین مبلغ، در خود جمله، نه عمومی. */
export function learnableKeyword(label, text, category) {
  const keyword = normalizeTopicLabel(label);
  const normalized = normalizePersian(keyword);
  if (normalized.length < 3 || normalized.length > 40) return null;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 4 || words.every((word) => GENERIC_WORDS.has(word) || /^\d+$/.test(word))) return null;
  if (topicLabelKey(keyword) === topicLabelKey(category)) return null;
  if (!normalizePersian(text).includes(normalized)) return null;
  return keyword;
}

// ---------------------------------------------------------------------------
// ثبت درس‌ها
// ---------------------------------------------------------------------------

/**
 * درس‌های یک پروندهٔ ثبت‌شده. پس از COMMIT صدا زده می‌شود و شکستش هرگز ثبت را
 * برنمی‌گرداند (صدازننده خطا را می‌بلعد).
 */
export function recordAiLessons({ caseId, transcript, components = [], now = new Date() } = {}) {
  ensureAiLessonSchema();
  const text = String(transcript || '').trim();
  if (!caseId || !text || !components.length) return [];
  const learnings = currentLearnings();
  const view = deterministicView(text, { learnings, accounts: currentAccounts(), now });
  if (view.path !== 'parser' || !view.rows.length) return [];
  const free = view.rows.map((row) => ({ ...row }));
  const recorded = [];
  for (const component of components) {
    const amount = Number(component.amount);
    const index = free.findIndex((row) => !row.used && row.amount === amount);
    const row = index >= 0 ? free[index] : null;
    if (row) row.used = true;
    const item = component.item || null;
    const final = { kind: component.kind, amount, type: item?.type || null, category: item?.category || null, topicLabel: item?.topicLabel || null, fundedBy: item?.fundedBy?.kind || null };
    const context = { caseId, componentId: component.id || String(amount), text, final, parser: { path: view.path, rows: view.rows } };
    if (!row) {
      // پارسر ردیف ساخت ولی با مبلغ دیگر.
      recorded.push(recordStructural({ ...context, flags: ['amount'], parserCategory: null }));
      continue;
    }
    const flags = [];
    if (component.kind === 'obligation') { if (!row.unpaid) flags.push('cash-for-unpaid'); else continue; }
    else if (component.kind === 'transfer') flags.push('transfer-as-row');
    else if (component.kind === 'settlement' || component.kind === 'partner-settlement') flags.push('settlement-as-row');
    else if (component.kind === 'cash' && item) {
      if (row.type !== item.type) flags.push('direction');
      if (item.fundedBy) flags.push('paid-by-other');
      if (row.unpaid) flags.push('unpaid-for-paid');
    } else continue;
    if (flags.length) {
      recorded.push(recordStructural({ ...context, flags, parserCategory: row.category }));
      continue;
    }
    if (row.category === item.category || GENERIC_CATEGORIES.has(item.category)) continue;
    recorded.push(recordCategory({ ...context, row, item, learnings, now }));
  }
  return recorded.filter(Boolean);
}

function recordStructural({ caseId, componentId, text, final, parser, flags, parserCategory }) {
  const key = `structural|${caseId}|${componentId}`;
  const existing = db.prepare('SELECT id FROM ai_lessons WHERE lesson_key=?').get(key);
  if (existing) return existing.id;
  const id = `al-${randomUUID()}`;
  db.prepare(`INSERT INTO ai_lessons (id,kind,lesson_key,category,parser_category,flags,case_ids,sample,parser,final,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'open')`)
    .run(id, 'structural', key, final.category, parserCategory, JSON.stringify(flags), JSON.stringify([caseId]), text.slice(0, 500), JSON.stringify(parser), JSON.stringify(final));
  return id;
}

function recordCategory({ caseId, componentId, text, final, parser, row, item, learnings, now }) {
  const keyword = learnableKeyword(item.topicLabel, text, item.category);
  // درسی که همین جمله را درست نمی‌کند (یا جهتش را عوض می‌کند) درس نیست.
  const trial = keyword && (parseFinancialText(text, {
    learnings: [{ keyword, category: item.category, source: 'ai' }, ...learnings.filter((learning) => normalizePersian(learning.keyword) !== normalizePersian(keyword))],
    source: 'text', now,
  }).transactions || []).some((candidate) => candidate.amount === item.amount && candidate.type === item.type && candidate.category === item.category);
  if (!trial) return recordStructural({ caseId, componentId, text, final, parser, flags: ['category-unlearnable'], parserCategory: row.category });
  const key = `category|${topicLabelKey(keyword)}|${item.category}`;
  const existing = db.prepare('SELECT * FROM ai_lessons WHERE lesson_key=?').get(key);
  if (existing) {
    const cases = json(existing.case_ids, []);
    if (cases.includes(caseId)) return existing.id;
    db.prepare(`UPDATE ai_lessons SET confirmations=confirmations+1,case_ids=?,sample=?,parser_category=?,parser=?,final=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(JSON.stringify([...cases, caseId].slice(-10)), text.slice(0, 500), row.category, JSON.stringify(parser), JSON.stringify(final), existing.id);
    maybeLearn(existing.id);
    return existing.id;
  }
  const id = `al-${randomUUID()}`;
  db.prepare(`INSERT INTO ai_lessons (id,kind,lesson_key,keyword,category,parser_category,case_ids,sample,parser,final,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'watching')`)
    .run(id, 'category', key, keyword, item.category, row.category, JSON.stringify([caseId]), text.slice(0, 500), JSON.stringify(parser), JSON.stringify(final));
  maybeLearn(id);
  return id;
}

/** همان موضوع، دستهٔ دیگر: AI دو جور فهمیده و تصمیم با انسان است. */
function rivalOf(lesson) {
  const keyPrefix = `${lesson.lesson_key.split('|').slice(0, 2).join('|')}|`;
  return db.prepare(`SELECT id FROM ai_lessons WHERE kind='category' AND id<>? AND substr(lesson_key,1,?)=? AND status IN ('watching','learned','conflict')`)
    .get(lesson.id, keyPrefix.length, keyPrefix);
}

function maybeLearn(id) {
  const lesson = db.prepare('SELECT * FROM ai_lessons WHERE id=?').get(id);
  if (!lesson || lesson.kind !== 'category' || lesson.status !== 'watching') return;
  if (lesson.confirmations < aiLessonThreshold() || rivalOf(lesson)) return;
  learn(lesson, { replace: false, actor: null });
}

/** نوشتن در «آنچه یاد گرفته‌ام»؛ یادگیریِ دیگرِ همان واژه فقط با «جایگزین کن» عوض می‌شود. */
function learn(lesson, { replace = false, actor = null } = {}) {
  const current = db.prepare('SELECT id,category,source FROM learnings WHERE keyword=?').get(lesson.keyword);
  let learningId = current?.id || null;
  let status = 'learned';
  if (current && current.category !== lesson.category) {
    if (!replace) status = 'conflict';
    else db.prepare("UPDATE learnings SET category=?,source='ai',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lesson.category, current.id);
  } else if (!current) {
    learningId = randomUUID();
    db.prepare("INSERT INTO learnings (id,keyword,category,source) VALUES (?,?,?,'ai')").run(learningId, lesson.keyword, lesson.category);
  }
  db.prepare('UPDATE ai_lessons SET status=?,learning_id=?,decided_by=?,decided_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(status, status === 'learned' ? learningId : null, actor, actor ? new Date().toISOString() : null, lesson.id);
  audit(status === 'learned' ? 'learn' : 'conflict', 'ai_lesson', lesson.id, { keyword: lesson.keyword, category: lesson.category, replaced: Boolean(current && replace), by: actor ? 'user' : 'threshold' });
  return status;
}

/** یادگیریِ AI که کاربر پاک یا اصلاح کرد، دیگر خودکار برنمی‌گردد. */
export function forgetAiLesson(learningId) {
  ensureAiLessonSchema();
  db.prepare("UPDATE ai_lessons SET status='dismissed',updated_at=CURRENT_TIMESTAMP WHERE kind='category' AND learning_id=? AND status='learned'").run(String(learningId || ''));
}

// ---------------------------------------------------------------------------
// خواندن، تصمیم و گزارش
// ---------------------------------------------------------------------------

const lessonView = (row) => ({
  id: row.id, kind: row.kind, keyword: row.keyword, category: row.category, parserCategory: row.parser_category,
  flags: json(row.flags, []).map((flag) => ({ id: flag, label: STRUCTURAL_FLAGS[flag] || flag })),
  confirmations: row.confirmations, caseIds: json(row.case_ids, []), sample: row.sample,
  parser: json(row.parser, {}), final: json(row.final, {}), status: row.status, learningId: row.learning_id,
  decidedAt: row.decided_at, createdAt: row.created_at, updatedAt: row.updated_at,
});

export function listAiLessons({ limit = 200 } = {}) {
  ensureAiLessonSchema();
  const rows = db.prepare(`SELECT * FROM ai_lessons ORDER BY
      CASE status WHEN 'conflict' THEN 0 WHEN 'watching' THEN 1 WHEN 'open' THEN 2 WHEN 'learned' THEN 3 ELSE 4 END, updated_at DESC
    LIMIT ?`).all(Math.min(Math.max(Number(limit) || 200, 1), 1000));
  return { threshold: aiLessonThreshold(), lessons: rows.map(lessonView) };
}

export function decideAiLesson(id, { decision } = {}) {
  ensureAiLessonSchema();
  const lesson = db.prepare('SELECT * FROM ai_lessons WHERE id=?').get(String(id || ''));
  if (!lesson) throw lessonError('این درس پیدا نشد.', 'AI_LESSON_MISSING', 404);
  const actor = currentWorkspace()?.userId || 'user';
  if (lesson.kind === 'structural') {
    if (decision !== 'reviewed') throw lessonError('اختلاف ساختاری خودکار یاد گرفته نمی‌شود؛ فقط «دیدم» دارد.');
    db.prepare("UPDATE ai_lessons SET status='reviewed',decided_by=?,decided_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(actor, new Date().toISOString(), lesson.id);
    audit('review', 'ai_lesson', lesson.id, { flags: json(lesson.flags, []) });
  } else if (decision === 'learn' || decision === 'replace') {
    if (lesson.status === 'learned') return lessonView(db.prepare('SELECT * FROM ai_lessons WHERE id=?').get(lesson.id));
    const status = learn(lesson, { replace: decision === 'replace', actor });
    if (status === 'conflict' && decision === 'learn') {
      throw lessonError('برای همین واژه یادگیریِ دیگری هست؛ اگر می‌خواهی عوض شود «جایگزین کن» را بزن.', 'AI_LESSON_CONFLICT', 409);
    }
  } else if (decision === 'dismiss') {
    if (lesson.status === 'learned' && lesson.learning_id) {
      db.prepare("DELETE FROM learnings WHERE id=? AND source='ai'").run(lesson.learning_id);
    }
    db.prepare("UPDATE ai_lessons SET status='dismissed',decided_by=?,decided_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(actor, new Date().toISOString(), lesson.id);
    audit('dismiss', 'ai_lesson', lesson.id, { keyword: lesson.keyword, category: lesson.category });
  } else {
    throw lessonError('تصمیم نامعتبر است.');
  }
  return lessonView(db.prepare('SELECT * FROM ai_lessons WHERE id=?').get(lesson.id));
}

/**
 * گزارش اختلاف‌ها برای بهبود خودِ پارسر (لایهٔ سوم). جملهٔ کامل را دارد، چون بدون آن
 * قاعده‌ای نوشته نمی‌شود؛ نام دفتر و کاربر را ندارد. فرستادنش تصمیمِ صاحب دفتر است.
 */
export function exportAiLessons() {
  ensureAiLessonSchema();
  const rows = db.prepare('SELECT * FROM ai_lessons ORDER BY created_at').all();
  return {
    format: 'hesab-yar-ai-lessons', version: 1, exportedAt: new Date().toISOString(), threshold: aiLessonThreshold(),
    lessons: rows.map((row) => {
      const view = lessonView(row);
      return { kind: view.kind, status: view.status, keyword: view.keyword, category: view.category, parserCategory: view.parserCategory,
        flags: view.flags.map((flag) => flag.id), confirmations: view.confirmations, sample: view.sample, parser: view.parser, final: view.final, createdAt: view.createdAt };
    }),
  };
}
