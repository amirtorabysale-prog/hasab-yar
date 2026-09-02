import { randomUUID } from 'node:crypto';

const HIGH_RISK = /(?:اعتراض|جر(?:ی|ي)مه|معاف(?:یت|يت)|اظهارنامه|رس(?:ی|ي)دگ(?:ی|ي)|دادرسی|پرونده|تشخیص|قطعی|سامانه مودیان|صورتحساب الکترونیکی)/;
const STOP_WORDS = new Set(['برای', 'این', 'آیا', 'است', 'هست', 'من', 'ما', 'یک', 'که', 'را', 'در', 'از', 'به', 'با', 'چه', 'چطور', 'باید']);

function fail(message, code = 'TAX_ASSISTANT_INVALID', status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function text(value, max = 500) { return String(value || '').trim().slice(0, max); }
function json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function tokens(value) {
  return [...new Set(text(value, 2000).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 2 && !STOP_WORDS.has(item)))];
}

export function ensureTaxAssistantSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tax_knowledge_sources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      issuer TEXT NOT NULL,
      jurisdiction TEXT NOT NULL DEFAULT 'IR',
      official_url TEXT NOT NULL,
      summary TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      version_label TEXT NOT NULL,
      published_at TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      verified_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','withdrawn')),
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tax_knowledge_validity ON tax_knowledge_sources(status,effective_from,effective_to);
    CREATE TABLE IF NOT EXISTS tax_assistant_questions (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      question_kind TEXT NOT NULL CHECK(question_kind IN ('general','case')),
      context_note TEXT NOT NULL DEFAULT '',
      related_entities TEXT NOT NULL DEFAULT '[]',
      risk_level TEXT NOT NULL CHECK(risk_level IN ('low','high')),
      status TEXT NOT NULL CHECK(status IN ('answered','referred','resolved')),
      answer TEXT NOT NULL DEFAULT '',
      source_snapshot TEXT NOT NULL DEFAULT '[]',
      referral_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      answered_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tax_assistant_status ON tax_assistant_questions(status,created_at);
  `);
}

function sourceRow(row, now = new Date()) {
  if (!row) return null;
  const today = now.toISOString().slice(0, 10);
  const expired = Boolean(row.status !== 'active' || row.effective_from > today || (row.effective_to && row.effective_to < today));
  return {
    id: row.id, title: row.title, issuer: row.issuer, jurisdiction: row.jurisdiction,
    officialUrl: row.official_url, summary: row.summary, keywords: json(row.keywords, []),
    versionLabel: row.version_label, publishedAt: row.published_at, effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to, verifiedAt: row.verified_at, status: expired ? 'expired' : row.status,
    expired, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function questionRow(row) {
  if (!row) return null;
  return {
    id: row.id, question: row.question, questionKind: row.question_kind, contextNote: row.context_note,
    relatedEntities: json(row.related_entities, []), riskLevel: row.risk_level, status: row.status,
    answer: row.answer, sources: json(row.source_snapshot, []), referralReason: row.referral_reason,
    createdBy: row.created_by, answeredBy: row.answered_by, createdAt: row.created_at, answeredAt: row.answered_at,
    disclaimer: 'این پاسخ اطلاعات عمومی منبع‌دار است و جایگزین نظر متخصص دربارهٔ پرونده یا اقدام در سامانه‌های رسمی نیست.',
  };
}

export function saveTaxKnowledgeSource(database, values = {}, actor = {}) {
  const id = text(values.id, 80) || randomUUID();
  const title = text(values.title, 180), issuer = text(values.issuer, 140), officialUrl = text(values.officialUrl, 600);
  const summary = text(values.summary, 4000), versionLabel = text(values.versionLabel, 100);
  const effectiveFrom = text(values.effectiveFrom, 10), effectiveTo = text(values.effectiveTo, 10) || null;
  const verifiedAt = text(values.verifiedAt, 10) || new Date().toISOString().slice(0, 10);
  if (!title || !issuer || !summary || !versionLabel || !effectiveFrom) fail('عنوان، صادرکننده، خلاصه، نسخه و تاریخ شروع اعتبار منبع الزامی است.');
  let parsed;
  try { parsed = new URL(officialUrl); } catch { fail('پیوند رسمی منبع معتبر نیست.', 'TAX_SOURCE_URL_INVALID'); }
  if (parsed.protocol !== 'https:') fail('منبع مالیاتی باید پیوند امن HTTPS داشته باشد.', 'TAX_SOURCE_URL_INVALID');
  if (effectiveTo && effectiveTo < effectiveFrom) fail('پایان اعتبار نمی‌تواند قبل از شروع اعتبار باشد.', 'TAX_SOURCE_DATE_INVALID');
  const keywords = [...new Set([...(Array.isArray(values.keywords) ? values.keywords : text(values.keywords, 800).split(/[،,]/)), ...tokens(title)])]
    .map((item) => text(item, 60)).filter(Boolean).slice(0, 30);
  const status = ['active', 'expired', 'withdrawn'].includes(values.status) ? values.status : 'active';
  database.prepare(`INSERT INTO tax_knowledge_sources
    (id,title,issuer,jurisdiction,official_url,summary,keywords,version_label,published_at,effective_from,effective_to,verified_at,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,issuer=excluded.issuer,jurisdiction=excluded.jurisdiction,
      official_url=excluded.official_url,summary=excluded.summary,keywords=excluded.keywords,version_label=excluded.version_label,
      published_at=excluded.published_at,effective_from=excluded.effective_from,effective_to=excluded.effective_to,
      verified_at=excluded.verified_at,status=excluded.status,updated_at=CURRENT_TIMESTAMP`)
    .run(id, title, issuer, text(values.jurisdiction, 12) || 'IR', officialUrl, summary, JSON.stringify(keywords), versionLabel,
      text(values.publishedAt, 10) || null, effectiveFrom, effectiveTo, verifiedAt, status, actor.userId || null);
  return sourceRow(database.prepare('SELECT * FROM tax_knowledge_sources WHERE id=?').get(id));
}

export function listTaxKnowledgeSources(database, { includeExpired = true } = {}) {
  const rows = database.prepare(`SELECT * FROM tax_knowledge_sources ${includeExpired ? '' : "WHERE status='active'"} ORDER BY effective_from DESC,title`).all();
  return rows.map((row) => sourceRow(row));
}

function matchingSources(database, question) {
  const requested = tokens(question);
  const today = new Date().toISOString().slice(0, 10);
  return database.prepare(`SELECT * FROM tax_knowledge_sources WHERE status='active' AND effective_from<=?
    AND (effective_to IS NULL OR effective_to>=?) ORDER BY verified_at DESC,effective_from DESC`).all(today, today)
    .map((row) => ({ source: sourceRow(row), score: json(row.keywords, []).filter((word) => requested.includes(String(word).toLowerCase())).length }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((item) => item.source);
}

export function askTaxAssistant(database, values = {}, actor = {}) {
  const question = text(values.question, 1200);
  if (question.length < 8) fail('سؤال مالیاتی را کامل‌تر بنویس.', 'TAX_QUESTION_TOO_SHORT');
  const kind = values.questionKind === 'case' ? 'case' : 'general';
  const highRisk = kind === 'case' || HIGH_RISK.test(question);
  const sources = highRisk ? [] : matchingSources(database, question);
  const status = sources.length ? 'answered' : 'referred';
  const referralReason = highRisk
    ? 'این سؤال به وضعیت پرونده، مهلت، جریمه یا تشخیص حرفه‌ای وابسته است و باید توسط متخصص بررسی شود.'
    : 'در پایگاه فعلی منبع رسمی معتبر و مرتبط کافی برای پاسخ پیدا نشد.';
  const answer = sources.length ? sources.map((source) => source.summary).join('\n\n') : '';
  const id = randomUUID();
  const snapshot = sources.map(({ id: sourceId, title, issuer, officialUrl, versionLabel, effectiveFrom, effectiveTo, verifiedAt }) => (
    { id: sourceId, title, issuer, officialUrl, versionLabel, effectiveFrom, effectiveTo, verifiedAt }
  ));
  const related = (Array.isArray(values.relatedEntities) ? values.relatedEntities : []).slice(0, 20)
    .map((item) => ({ type: text(item?.type, 40), id: text(item?.id, 100), label: text(item?.label, 140) })).filter((item) => item.type && item.id);
  database.prepare(`INSERT INTO tax_assistant_questions
    (id,question,question_kind,context_note,related_entities,risk_level,status,answer,source_snapshot,referral_reason,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, question, kind, text(values.contextNote, 2000), JSON.stringify(related), highRisk ? 'high' : 'low', status,
      answer, JSON.stringify(snapshot), sources.length ? '' : referralReason, actor.userId || null);
  return questionRow(database.prepare('SELECT * FROM tax_assistant_questions WHERE id=?').get(id));
}

export function listTaxAssistantQuestions(database, filters = {}) {
  const status = ['answered', 'referred', 'resolved'].includes(filters.status) ? filters.status : '';
  return database.prepare(`SELECT * FROM tax_assistant_questions ${status ? 'WHERE status=?' : ''} ORDER BY created_at DESC LIMIT 100`)
    .all(...(status ? [status] : [])).map(questionRow);
}

export function resolveTaxAssistantQuestion(database, id, values = {}, actor = {}) {
  const current = database.prepare('SELECT * FROM tax_assistant_questions WHERE id=?').get(id);
  if (!current) return null;
  const answer = text(values.answer, 5000);
  const sourceIds = (Array.isArray(values.sourceIds) ? values.sourceIds : []).map((item) => text(item, 80)).filter(Boolean).slice(0, 10);
  if (!answer) fail('پاسخ متخصص الزامی است.', 'TAX_EXPERT_ANSWER_REQUIRED');
  if (!sourceIds.length) fail('پاسخ متخصص هم باید دست‌کم یک منبع رسمی داشته باشد.', 'TAX_EXPERT_SOURCE_REQUIRED');
  const placeholders = sourceIds.map(() => '?').join(',');
  const sources = database.prepare(`SELECT * FROM tax_knowledge_sources WHERE id IN (${placeholders})`).all(...sourceIds).map((row) => sourceRow(row));
  if (sources.length !== sourceIds.length || sources.some((item) => item.expired)) fail('یکی از منابع انتخاب‌شده معتبر یا فعال نیست.', 'TAX_EXPERT_SOURCE_INVALID');
  const snapshot = sources.map(({ id: sourceId, title, issuer, officialUrl, versionLabel, effectiveFrom, effectiveTo, verifiedAt }) => (
    { id: sourceId, title, issuer, officialUrl, versionLabel, effectiveFrom, effectiveTo, verifiedAt }
  ));
  database.prepare(`UPDATE tax_assistant_questions SET status='resolved',answer=?,source_snapshot=?,referral_reason='',answered_by=?,answered_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(answer, JSON.stringify(snapshot), actor.userId || null, id);
  return questionRow(database.prepare('SELECT * FROM tax_assistant_questions WHERE id=?').get(id));
}
