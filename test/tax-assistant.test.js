import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('tax-assistant');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'tax-assistant-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');

const database = await import(`../server/db.js?tax-assistant=${process.pid}`);
const { minimumRoleForRequest, roleAllows } = await import('../server/access.js');
database.ensureAdmin();
const inPrimary = (role, callback) => database.runInWorkspace('primary', { role, userId: `${role}-tax-user` }, callback);

let source;

test('stores versioned official sources and answers only matching low-risk general questions', () => inPrimary('manager', () => {
  source = database.saveTaxKnowledgeSource({
    title: 'راهنمای رسمی هزینه‌های قابل قبول آزمون', issuer: 'مرجع رسمی آزمون',
    officialUrl: 'https://example.gov.ir/tax/guide', versionLabel: 'نسخه ۱۴۰۵/۱',
    effectiveFrom: '2026-03-21', verifiedAt: '2026-09-01', keywords: ['هزینه', 'قابل قبول'],
    summary: 'پذیرش هزینه منوط به ارتباط با فعالیت و وجود مدارک مثبته است؛ مصداق پرونده باید جداگانه بررسی شود.',
  });
  assert.equal(source.expired, false);
  const result = database.askTaxAssistant({ question: 'شرایط عمومی هزینه قابل قبول چیست؟', questionKind: 'general' });
  assert.equal(result.status, 'answered');
  assert.equal(result.riskLevel, 'low');
  assert.equal(result.sources[0].officialUrl, 'https://example.gov.ir/tax/guide');
  assert.match(result.answer, /مدارک مثبته/);
  assert.match(result.disclaimer, /جایگزین نظر متخصص/);
}));

test('refers case-specific and unsupported questions instead of guessing', () => inPrimary('viewer', () => {
  const caseQuestion = database.askTaxAssistant({ question: 'برای اعتراض به جریمه پرونده من دقیقاً چه کار کنم؟', questionKind: 'case' });
  assert.equal(caseQuestion.status, 'referred');
  assert.equal(caseQuestion.riskLevel, 'high');
  assert.equal(caseQuestion.answer, '');
  assert.match(caseQuestion.referralReason, /متخصص/);

  const unsupported = database.askTaxAssistant({ question: 'تکلیف مالیاتی رمزارز چیست؟', questionKind: 'general' });
  assert.equal(unsupported.status, 'referred');
  assert.match(unsupported.referralReason, /منبع رسمی/);
}));

test('requires an active source for expert resolution and preserves the source snapshot', () => inPrimary('manager', () => {
  const referred = database.listTaxAssistantQuestions({ status: 'referred' })[0];
  assert.throws(() => database.resolveTaxAssistantQuestion(referred.id, { answer: 'پاسخ بدون منبع', sourceIds: [] }), (error) => error.code === 'TAX_EXPERT_SOURCE_REQUIRED');
  const resolved = database.resolveTaxAssistantQuestion(referred.id, { answer: 'این پاسخ پس از بررسی متخصص ثبت شده است.', sourceIds: [source.id] });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.sources[0].versionLabel, 'نسخه ۱۴۰۵/۱');
  assert.equal(resolved.answeredBy, 'manager-tax-user');
}));

test('enforces manager access for source changes and expert answers', () => {
  assert.equal(roleAllows('viewer', minimumRoleForRequest('POST', '/tax-assistant/questions')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/tax-assistant/sources')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/tax-assistant/sources')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/tax-assistant/questions/id/resolve')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/tax-assistant/questions/id/resolve')), true);
});

test('includes tax knowledge and question history in portable backup data', () => inPrimary('owner', () => {
  const snapshot = database.financialBackupSnapshot({ id: 'primary' });
  assert.equal(snapshot.tables.tax_knowledge_sources.some((item) => item.id === source.id), true);
  assert.equal(snapshot.tables.tax_assistant_questions.length >= 2, true);
}));

test.after(() => {
  database.closeWorkspaceDatabases(); database.db.close();
  removeTempDatabase(databasePath);
});
