import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('tax-knowledge');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'tax-knowledge-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');

const database = await import(`../server/db.js?tax-knowledge=${process.pid}`);
const core = await import(`../server/taxKnowledge.js?tax-knowledge=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'tax-knowledge-test' }, callback);
}

const publish = (values) => {
  const db = database.activeWorkspaceDatabase();
  const documentId = randomBytes(8).toString('hex');
  const versionId = randomBytes(8).toString('hex');
  db.prepare(`INSERT INTO tax_documents (id,document_class,authority_tier,issuer,official_number,title,fiscal_year)
    VALUES (?,?,?,?,?,?,?)`).run(documentId, values.documentClass, values.authorityTier, values.issuer || 'مرجع',
    values.officialNumber || '', values.title, values.fiscalYear || '');
  db.prepare(`INSERT INTO tax_document_versions
    (id,document_id,version_label,effective_from,effective_to,known_from,status,official_url,summary,verified_by,verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(versionId, documentId, values.versionLabel || 'v1',
    values.effectiveFrom, values.effectiveTo || null, values.knownFrom || values.effectiveFrom,
    values.status || 'active', values.officialUrl || 'https://tax.gov.ir/x', values.summary || '',
    values.verified === false ? null : 'reviewer', values.verified === false ? null : values.effectiveFrom);
  return { documentId, versionId };
};

test('منبع موجود بدون از دست رفتن داده به مدل نسخه‌دار مهاجرت می‌کند', () => inPrimary(() => {
  const legacy = database.saveTaxKnowledgeSource({
    title: 'دستورالعمل نمونه', issuer: 'سازمان امور مالیاتی', officialUrl: 'https://intamedia.ir/sample',
    summary: 'خلاصهٔ رسمی', versionLabel: '۲۰۰/۱۴۰۵/۱', effectiveFrom: '2026-01-01',
  });
  const result = core.migrateTaxKnowledgeSources(database.activeWorkspaceDatabase());
  assert.ok(result.migrated + result.updated >= 1);

  const migrated = database.listTaxDocuments().find((item) => item.legacySourceId === legacy.id);
  assert.equal(migrated.title, 'دستورالعمل نمونه');
  assert.equal(migrated.issuer, 'سازمان امور مالیاتی');
  // طبقه‌بندی حدس زده نمی‌شود: پایین‌ترین ردیفِ هنوز قابل استناد تا وقتی انسانی تعیین کند.
  assert.equal(migrated.documentClass, 'opinion');
  assert.equal(migrated.authorityTier, 5);

  const full = database.getTaxDocument(migrated.id);
  assert.equal(full.versions.length, 1);
  assert.equal(full.versions[0].officialUrl, 'https://intamedia.ir/sample');
  assert.equal(full.versions[0].effectiveFrom, '2026-01-01');
  // منبعی که مدیر دفتر قبلاً تأیید کرده بود، دوباره به صف بازبینی برنمی‌گردد.
  assert.equal(full.versions[0].verified, true);
}));

test('مهاجرت دوباره، سند تکراری نمی‌سازد', () => inPrimary(() => {
  const before = database.listTaxDocuments().length;
  core.migrateTaxKnowledgeSources(database.activeWorkspaceDatabase());
  core.migrateTaxKnowledgeSources(database.activeWorkspaceDatabase());
  assert.equal(database.listTaxDocuments().length, before);
}));

test('خبر و پیش‌نویس ذخیره می‌شوند ولی هرگز قابل استناد نیستند', () => inPrimary(() => {
  publish({ documentClass: 'news', authorityTier: 7, title: 'خبر نرخ تازه', effectiveFrom: '2026-01-01' });
  publish({ documentClass: 'draft', authorityTier: 7, title: 'پیش‌نویس لایحه', effectiveFrom: '2026-01-01' });
  publish({ documentClass: 'educational', authorityTier: 6, title: 'جزوهٔ آموزشی', effectiveFrom: '2026-01-01' });
  const circular = publish({ documentClass: 'circular', authorityTier: 4, title: 'بخشنامهٔ واقعی', effectiveFrom: '2026-01-01' });

  const titles = database.listTaxDocuments().map((item) => item.title);
  assert.ok(titles.includes('خبر نرخ تازه'), 'خبر باید ذخیره شود تا کاربر بداند چیزی در راه است');

  const citable = database.citableTaxVersions({ asOf: '2026-06-01' });
  const citableTitles = citable.map((item) => item.document.title);
  assert.ok(citableTitles.includes('بخشنامهٔ واقعی'));
  assert.ok(!citableTitles.includes('خبر نرخ تازه'));
  assert.ok(!citableTitles.includes('پیش‌نویس لایحه'));
  assert.ok(!citableTitles.includes('جزوهٔ آموزشی'));
  assert.ok(citable.every((item) => item.document.citable));
  assert.ok(citable.some((item) => item.id === circular.versionId));
}));

test('نسخهٔ بدون تأیید انسانی در بازیابی نمی‌آید', () => inPrimary(() => {
  const pending = publish({
    documentClass: 'circular', authorityTier: 4, title: 'بخشنامهٔ بازبینی‌نشده',
    effectiveFrom: '2026-01-01', verified: false,
  });
  const citable = database.citableTaxVersions({ asOf: '2026-06-01' });
  assert.ok(!citable.some((item) => item.id === pending.versionId));
}));

test('بازیابی با تاریخ پرسش کار می‌کند، نه با امروز', () => inPrimary(() => {
  const old = publish({
    documentClass: 'circular', authorityTier: 4, title: 'بخشنامهٔ منقضی',
    effectiveFrom: '2024-01-01', effectiveTo: '2024-12-29',
  });
  assert.ok(database.citableTaxVersions({ asOf: '2024-06-01' }).some((item) => item.id === old.versionId));
  assert.ok(!database.citableTaxVersions({ asOf: '2026-06-01' }).some((item) => item.id === old.versionId));
}));

test('ابطال، سند را از آینده بیرون می‌برد ولی گذشته را پاک نمی‌کند', () => inPrimary(() => {
  const target = publish({
    documentClass: 'circular', authorityTier: 4, title: 'بخشنامهٔ ابطال‌شده', effectiveFrom: '2024-01-01',
  });
  const ruling = publish({
    documentClass: 'ruling', authorityTier: 3, title: 'رأی هیئت عمومی', issuer: 'دیوان عدالت اداری',
    effectiveFrom: '2025-05-01',
  });
  database.saveTaxDocumentRelation({
    sourceVersionId: ruling.versionId, targetVersionId: target.versionId,
    relation: 'annuls', effectFrom: '2025-05-01', note: 'ابطال مقرره',
  });

  const before = database.citableTaxVersions({ asOf: '2025-01-01' }).map((item) => item.id);
  assert.ok(before.includes(target.versionId), 'پاسخ به سؤال سال‌های پیش از ابطال هنوز به این سند نیاز دارد');
  const after = database.citableTaxVersions({ asOf: '2025-09-01' }).map((item) => item.id);
  assert.ok(!after.includes(target.versionId));
  // خودِ رأی ابطالی همچنان قابل استناد است.
  assert.ok(after.includes(ruling.versionId));
}));

test('حکم بودجهٔ یک سال به سال دیگر تعمیم داده نمی‌شود', () => inPrimary(() => {
  const budget = publish({
    documentClass: 'law', authorityTier: 1, title: 'احکام مالیاتی بودجهٔ ۱۴۰۵', issuer: 'مجلس',
    effectiveFrom: '2026-03-21', fiscalYear: '1405',
  });
  assert.ok(database.citableTaxVersions({ asOf: '2026-06-01', fiscalYear: '1405' }).some((item) => item.id === budget.versionId));
  assert.ok(!database.citableTaxVersions({ asOf: '2026-06-01', fiscalYear: '1404' }).some((item) => item.id === budget.versionId));
  // بدون تعیین سال، حکم سال‌دار حذف نمی‌شود؛ فیلتر فقط وقتی سال پرسیده شده اعمال می‌شود.
  assert.ok(database.citableTaxVersions({ asOf: '2026-06-01' }).some((item) => item.id === budget.versionId));
}));

test('رابطهٔ نامعتبر یا معلق ثبت نمی‌شود', () => inPrimary(() => {
  const one = publish({ documentClass: 'circular', authorityTier: 4, title: 'الف', effectiveFrom: '2026-01-01' });
  assert.throws(() => database.saveTaxDocumentRelation({
    sourceVersionId: one.versionId, targetVersionId: one.versionId, relation: 'annuls',
  }), (error) => error.code === 'TAX_RELATION_INVALID');
  assert.throws(() => database.saveTaxDocumentRelation({
    sourceVersionId: one.versionId, targetVersionId: 'ناموجود', relation: 'annuls',
  }), (error) => error.code === 'TAX_RELATION_TARGET_MISSING');
  assert.throws(() => database.saveTaxDocumentRelation({
    sourceVersionId: one.versionId, targetVersionId: one.versionId, relation: 'خودساخته',
  }), (error) => error.code === 'TAX_RELATION_INVALID');
}));

test('مسیر امروزی دستیار مالیاتی دست‌نخورده می‌ماند', () => inPrimary(() => {
  // فاز ۰ نباید هیچ رفتاری را عوض کند: پاسخ هنوز از منابع قدیمی ساخته می‌شود.
  const sources = database.listTaxKnowledgeSources();
  assert.ok(sources.length >= 1);
  const answered = database.askTaxAssistant({ question: 'دستورالعمل نمونه چه می‌گوید؟' });
  assert.ok(['answered', 'referred'].includes(answered.status));
  const referred = database.askTaxAssistant({ question: 'جریمهٔ اظهارنامهٔ من چقدر است؟' });
  assert.equal(referred.status, 'referred');
  assert.equal(referred.riskLevel, 'high');
}));

test('جدول‌های تازه وارد پشتیبان می‌شوند و پشتیبان قدیمی بدون آنها معتبر می‌ماند', () => inPrimary(() => {
  const snapshot = database.financialBackupSnapshot();
  assert.ok(Array.isArray(snapshot.tables.tax_documents));
  assert.ok(Array.isArray(snapshot.tables.tax_document_versions));
  assert.ok(snapshot.tables.tax_documents.length >= 1);

  const legacyBackup = { ...snapshot, tables: { ...snapshot.tables } };
  for (const table of ['tax_documents', 'tax_document_versions', 'tax_provisions', 'tax_document_relations', 'tax_document_mirrors']) {
    delete legacyBackup.tables[table];
  }
  assert.doesNotThrow(() => database.restoreFinancialSnapshot(legacyBackup));
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  removeTempDatabase(databasePath);
});
