// هستهٔ منابع مالیاتی — فاز ۰ از [ماژول هوش مالیاتی](../docs/tax-intelligence-module.md).
//
// این فاز عمداً هیچ رفتاری را عوض نمی‌کند: جدول‌های نسخه‌دار ساخته می‌شوند،
// منابع موجود یک‌بار به آنها مهاجرت می‌کنند، و مسیر امروزی دستیار مالیاتی
// دست‌نخورده روی `tax_knowledge_sources` باقی می‌ماند. جایگزینی مسیر پاسخ، کار
// فاز ۲ و ۳ است — پس از اینکه بازیابی زمان‌آگاه ساخته و آزموده شود.
//
// دو تصمیم که کل درستی این هسته روی آنهاست:
//
// ۱. **ردیف اقتدار از کلاس سند جداست.** «چقدر معتبر است» و «چه نوع سندی است»
//    دو چیزند: خبرِ سازمان امور مالیاتی از مرجع رسمی می‌آید ولی هیچ اثر حقوقی
//    ندارد. اگر یک ستون بودند، خبر با اعتبار بخشنامه وارد پاسخ می‌شد.
//
// ۲. **زمان اعتبار از زمان دانش جداست.** «این مقرره از کی معتبر بود» با «ما از
//    کی این را می‌دانستیم» یکی نیست. بدون دومی نمی‌شود ثابت کرد پاسخی که پارسال
//    به مشتری داده‌ایم، با دانش همان روز درست بوده است.

import { randomUUID } from 'node:crypto';

/** کلاس سند: چه نوع متنی است. */
export const DOCUMENT_CLASSES = Object.freeze([
  'law', 'regulation', 'ruling', 'circular', 'opinion', 'educational', 'news', 'draft',
]);

/**
 * تنها کلاس‌هایی که می‌توانند مبنای پاسخ باشند.
 *
 * خبر، پیش‌نویس و جزوهٔ آموزشی ذخیره می‌شوند — کاربر باید بداند چیزی در راه است
 * یا کجا توضیح ساده‌تری هست — ولی هرگز به‌عنوان حجت استناد نمی‌شوند.
 */
export const CITABLE_CLASSES = Object.freeze(['law', 'regulation', 'ruling', 'circular', 'opinion']);

/** رابطهٔ میان اسناد. `annuls` برای ابطال دیوان عدالت اداری است. */
export const DOCUMENT_RELATIONS = Object.freeze([
  'amends', 'repeals', 'annuls', 'interprets', 'implements', 'replaces', 'references',
]);

export const VERSION_STATUSES = Object.freeze(['active', 'superseded', 'annulled', 'expired', 'withdrawn']);

function fail(message, code = 'TAX_KNOWLEDGE_INVALID', status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function text(value, max = 500) { return String(value || '').trim().slice(0, max); }
function day(value) { return text(value, 10); }

export function ensureTaxKnowledgeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tax_documents (
      id TEXT PRIMARY KEY,
      document_class TEXT NOT NULL CHECK(document_class IN
        ('law','regulation','ruling','circular','opinion','educational','news','draft')),
      authority_tier INTEGER NOT NULL CHECK(authority_tier BETWEEN 1 AND 7),
      issuer TEXT NOT NULL,
      official_number TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      jurisdiction TEXT NOT NULL DEFAULT 'IR',
      -- فقط برای احکام مالیاتی بودجهٔ سالانه؛ خالی یعنی محدود به یک سال نیست.
      fiscal_year TEXT NOT NULL DEFAULT '',
      subject_tags TEXT NOT NULL DEFAULT '[]',
      legacy_source_id TEXT UNIQUE,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tax_documents_class ON tax_documents(document_class,authority_tier);

    CREATE TABLE IF NOT EXISTS tax_document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES tax_documents(id) ON DELETE CASCADE,
      version_label TEXT NOT NULL,
      approved_at TEXT,
      published_at TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      -- زمان دانش: از کی این نسخه در پایگاه ما بود و تا کی باور ما این بود.
      known_from TEXT NOT NULL,
      known_to TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN
        ('active','superseded','annulled','expired','withdrawn')),
      official_url TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      raw_text TEXT NOT NULL DEFAULT '',
      -- دروازهٔ انسانی: بدون این دو، نسخه در بازیابی نمی‌آید.
      verified_by TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_id,version_label)
    );
    CREATE INDEX IF NOT EXISTS idx_tax_versions_validity
      ON tax_document_versions(status,effective_from,effective_to);

    CREATE TABLE IF NOT EXISTS tax_provisions (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES tax_document_versions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      citation TEXT NOT NULL,
      text TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tax_provisions_version ON tax_provisions(version_id,ordinal);

    CREATE TABLE IF NOT EXISTS tax_document_relations (
      id TEXT PRIMARY KEY,
      source_version_id TEXT NOT NULL REFERENCES tax_document_versions(id) ON DELETE CASCADE,
      target_version_id TEXT NOT NULL REFERENCES tax_document_versions(id) ON DELETE CASCADE,
      relation TEXT NOT NULL CHECK(relation IN
        ('amends','repeals','annuls','interprets','implements','replaces','references')),
      scope TEXT NOT NULL DEFAULT '',
      -- ابطال دیوان گاهی از تاریخ تصویب مقررهٔ باطل‌شده اثر دارد، نه از تاریخ رأی.
      effect_from TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_version_id,target_version_id,relation)
    );
    CREATE INDEX IF NOT EXISTS idx_tax_relations_target ON tax_document_relations(target_version_id,relation);

    -- گردآورنده‌های غیررسمی اینجا می‌نشینند، نه در official_url.
    CREATE TABLE IF NOT EXISTS tax_document_mirrors (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES tax_document_versions(id) ON DELETE CASCADE,
      mirror_url TEXT NOT NULL,
      provider TEXT NOT NULL,
      trust TEXT NOT NULL DEFAULT 'discovery' CHECK(trust IN ('discovery','unverified')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(version_id,mirror_url)
    );
  `);
}

function documentRow(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.subject_tags); } catch { tags = []; }
  return {
    id: row.id,
    documentClass: row.document_class,
    authorityTier: row.authority_tier,
    issuer: row.issuer,
    officialNumber: row.official_number,
    title: row.title,
    jurisdiction: row.jurisdiction,
    fiscalYear: row.fiscal_year,
    subjectTags: Array.isArray(tags) ? tags : [],
    legacySourceId: row.legacy_source_id || null,
    citable: CITABLE_CLASSES.includes(row.document_class),
    createdAt: row.created_at,
  };
}

function versionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    versionLabel: row.version_label,
    approvedAt: row.approved_at,
    publishedAt: row.published_at,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    knownFrom: row.known_from,
    knownTo: row.known_to,
    status: row.status,
    officialUrl: row.official_url,
    contentHash: row.content_hash,
    summary: row.summary,
    verifiedBy: row.verified_by || null,
    verifiedAt: row.verified_at || null,
    verified: Boolean(row.verified_at),
  };
}

/**
 * مهاجرت یک‌طرفهٔ منابع امروزی به مدل نسخه‌دار.
 *
 * `tax_knowledge_sources` حذف نمی‌شود و مسیر پاسخ فعلی همچنان از آن می‌خواند؛
 * این فقط همان داده را در ساختاری می‌گذارد که نسخه، رابطه و ماده می‌فهمد.
 *
 * idempotent است: `legacy_source_id` یکتاست، پس اجرای دوباره سند تکراری نمی‌سازد.
 * ردیف قدیمی اگر بعداً ویرایش شود، فراداده‌اش روی همان سند به‌روز می‌شود ولی
 * نسخهٔ تازه ساخته نمی‌شود — ساخت نسخه از روی تغییر، کار فاز ۱ است که hash متن
 * را دارد.
 *
 * ردیف قدیمی، کلاس سند و ردیف اقتدار ندارد. حدس‌زدنشان از روی نام صادرکننده
 * وسوسه‌انگیز است ولی همان اشتباهی است که کل این هسته برای بستنش ساخته شده: تا
 * وقتی انسانی طبقه‌بندی نکرده، سند مهاجرت‌کرده `opinion` با ردیف ۵ می‌ماند —
 * پایین‌ترین ردیفِ هنوز قابل استناد — تا نه اعتباری جعل شود و نه داده‌ای گم.
 */
export function migrateTaxKnowledgeSources(database, { now = new Date() } = {}) {
  ensureTaxKnowledgeSchema(database);
  const legacy = database.prepare('SELECT * FROM tax_knowledge_sources').all();
  if (!legacy.length) return { migrated: 0, updated: 0 };
  const today = now.toISOString().slice(0, 10);
  const insertDocument = database.prepare(`INSERT INTO tax_documents
    (id,document_class,authority_tier,issuer,official_number,title,jurisdiction,fiscal_year,subject_tags,legacy_source_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const updateDocument = database.prepare(`UPDATE tax_documents
    SET issuer=?,title=?,jurisdiction=?,subject_tags=?,updated_at=CURRENT_TIMESTAMP WHERE legacy_source_id=?`);
  const insertVersion = database.prepare(`INSERT INTO tax_document_versions
    (id,document_id,version_label,published_at,effective_from,effective_to,known_from,status,official_url,summary,verified_by,verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const findDocument = database.prepare('SELECT id FROM tax_documents WHERE legacy_source_id=?');

  let migrated = 0;
  let updated = 0;
  for (const source of legacy) {
    const existing = findDocument.get(source.id);
    if (existing) {
      updateDocument.run(source.issuer, source.title, source.jurisdiction, source.keywords, source.id);
      updated += 1;
      continue;
    }
    const documentId = randomUUID();
    insertDocument.run(documentId, 'opinion', 5, source.issuer, '', source.title,
      source.jurisdiction || 'IR', '', source.keywords || '[]', source.id);
    insertVersion.run(randomUUID(), documentId, source.version_label, source.published_at,
      source.effective_from, source.effective_to,
      // زمان دانش از تاریخ ثبت همان ردیف می‌آید، نه از امروز؛ وگرنه همهٔ سابقه
      // به روز مهاجرت منتقل می‌شد و «از کی می‌دانستیم» بی‌معنا می‌شد.
      (source.created_at || today).slice(0, 10),
      source.status || 'active', source.official_url, source.summary,
      // ردیف قدیمی با تأیید مدیر دفتر ثبت شده بود؛ همان تأیید حفظ می‌شود، نه
      // اینکه سند تأییدشده دوباره به صف بازبینی برگردد.
      source.created_by || null, source.verified_at || (source.created_at || today).slice(0, 10));
    migrated += 1;
  }
  return { migrated, updated };
}

/**
 * نسخه‌هایی که در تاریخ داده‌شده معتبر و قابل استناد بوده‌اند.
 *
 * `asOf` عمداً پارامتر است و پیش‌فرضش امروز نیست در سطح معنا: پرسش دربارهٔ
 * عملکرد ۱۴۰۳ باید با مقررات همان زمان پاسخ بگیرد، نه با مقررات امروز.
 *
 * سه فیلتر روی هم می‌نشینند و هر سه لازم‌اند:
 * ۱. کلاس سند قابل استناد باشد (خبر و پیش‌نویس و جزوه بیرون)؛
 * ۲. نسخه تأیید انسانی داشته باشد؛
 * ۳. تاریخ در بازهٔ اعتبار باشد و نسخه ابطال‌شده‌ای نباشد که اثر ابطالش پیش از
 *    این تاریخ شروع شده.
 */
export function citableVersionsAt(database, { asOf, fiscalYear = '' } = {}) {
  ensureTaxKnowledgeSchema(database);
  const at = day(asOf) || new Date().toISOString().slice(0, 10);
  const placeholders = CITABLE_CLASSES.map(() => '?').join(',');
  const rows = database.prepare(`SELECT v.*, d.document_class, d.authority_tier, d.issuer, d.title,
      d.official_number, d.fiscal_year, d.subject_tags, d.legacy_source_id, d.id AS doc_id
    FROM tax_document_versions v JOIN tax_documents d ON d.id=v.document_id
    WHERE d.document_class IN (${placeholders})
      AND v.verified_at IS NOT NULL
      AND v.status NOT IN ('withdrawn')
      AND v.effective_from<=?
      AND (v.effective_to IS NULL OR v.effective_to>=?)
    ORDER BY d.authority_tier, v.effective_from DESC`).all(...CITABLE_CLASSES, at, at);

  // ابطال با رابطه اعمال می‌شود، نه با وضعیت: همان سند برای سال‌های پیش از
  // اثرِ ابطال هنوز معتبر است و نباید از پایگاه پاک یا پنهان شود.
  const annulments = database.prepare(`SELECT target_version_id, effect_from
    FROM tax_document_relations WHERE relation IN ('annuls','repeals')`).all();
  const annulledBefore = new Map();
  for (const item of annulments) {
    const from = day(item.effect_from);
    const current = annulledBefore.get(item.target_version_id);
    if (!current || (from && from < current)) annulledBefore.set(item.target_version_id, from || '');
  }

  return rows
    .filter((row) => {
      const effect = annulledBefore.get(row.id);
      if (effect === undefined) return true;
      return effect ? at < effect : false;
    })
    // حکم بودجهٔ یک سال به سال دیگر تعمیم داده نمی‌شود.
    .filter((row) => !row.fiscal_year || !fiscalYear || row.fiscal_year === String(fiscalYear))
    .map((row) => ({
      ...versionRow(row),
      document: documentRow({ ...row, id: row.doc_id, subject_tags: row.subject_tags }),
    }));
}

export function listTaxDocuments(database, { documentClass = '' } = {}) {
  ensureTaxKnowledgeSchema(database);
  const rows = documentClass
    ? database.prepare('SELECT * FROM tax_documents WHERE document_class=? ORDER BY authority_tier,title').all(documentClass)
    : database.prepare('SELECT * FROM tax_documents ORDER BY authority_tier,title').all();
  return rows.map(documentRow);
}

export function getTaxDocument(database, id) {
  ensureTaxKnowledgeSchema(database);
  const document = documentRow(database.prepare('SELECT * FROM tax_documents WHERE id=?').get(id));
  if (!document) return null;
  const versions = database.prepare('SELECT * FROM tax_document_versions WHERE document_id=? ORDER BY effective_from DESC')
    .all(id).map(versionRow);
  const versionIds = versions.map((item) => item.id);
  const placeholders = versionIds.map(() => '?').join(',') || "''";
  const relations = versionIds.length
    ? database.prepare(`SELECT * FROM tax_document_relations
        WHERE source_version_id IN (${placeholders}) OR target_version_id IN (${placeholders})`)
      .all(...versionIds, ...versionIds)
    : [];
  return { ...document, versions, relations };
}

/**
 * ثبت رابطهٔ میان دو نسخه.
 * رابطه با خودِ نسخه ساخته نمی‌شود و هر دو طرف باید وجود داشته باشند؛ رابطهٔ
 * معلق به سندی که نیست، در بازیابی بی‌صدا نادیده گرفته می‌شد.
 */
export function saveTaxDocumentRelation(database, values = {}) {
  ensureTaxKnowledgeSchema(database);
  const relation = text(values.relation, 20);
  if (!DOCUMENT_RELATIONS.includes(relation)) fail('نوع رابطهٔ سند معتبر نیست.', 'TAX_RELATION_INVALID');
  const sourceId = text(values.sourceVersionId, 80);
  const targetId = text(values.targetVersionId, 80);
  if (!sourceId || !targetId) fail('هر دو طرف رابطه لازم است.', 'TAX_RELATION_INVALID');
  if (sourceId === targetId) fail('سند نمی‌تواند با خودش رابطه داشته باشد.', 'TAX_RELATION_INVALID');
  const exists = database.prepare('SELECT id FROM tax_document_versions WHERE id IN (?,?)').all(sourceId, targetId);
  if (exists.length !== 2) fail('یکی از نسخه‌های رابطه پیدا نشد.', 'TAX_RELATION_TARGET_MISSING', 404);
  const id = randomUUID();
  database.prepare(`INSERT INTO tax_document_relations (id,source_version_id,target_version_id,relation,scope,effect_from,note)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source_version_id,target_version_id,relation) DO UPDATE SET
      scope=excluded.scope,effect_from=excluded.effect_from,note=excluded.note`)
    .run(id, sourceId, targetId, relation, text(values.scope, 200), day(values.effectFrom) || null, text(values.note, 500));
  return database.prepare(`SELECT * FROM tax_document_relations
    WHERE source_version_id=? AND target_version_id=? AND relation=?`).get(sourceId, targetId, relation);
}
