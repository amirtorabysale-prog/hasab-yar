import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = `/tmp/hesab-yar-phase6-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'phase6-owner';
process.env.ADMIN_PASSWORD = 'phase6-safe-password-4829';
process.env.OPENAI_TRANSCRIBE_USD_PER_MINUTE = '0.02';
process.env.OPENAI_REALTIME_USD_PER_MINUTE = '0.03';
process.env.OPENAI_OCR_USD_PER_IMAGE = '0.005';

const database = await import(`../server/db.js?phase6=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('phase6-owner', 'phase6-safe-password-4829');

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
}

test('tracks quota and configured provider cost without limiting core entries', () => inPrimary(() => {
  const usageId = database.beginProviderUsage('server_voice', 'openai');
  database.finishProviderUsage(usageId, { provider: 'openai', durationMs: 30_000 });
  database.recordRealtimeProviderDuration(20_000);
  const status = database.commercialStatus('primary', new Date());
  assert.equal(status.usage.smartVoiceRequests, 1);
  assert.equal(status.coreEntryAlwaysAvailable, true);
  assert.equal(status.provider.pricingComplete, true);
  assert.equal(status.provider.estimatedCostMicrousd, 20_000);
}));

test('stops the paid provider before overage but still accepts a manual ledger entry', () => {
  const workspace = database.createWorkspace(owner.id, { name: 'دفتر کنترل سهمیه', profileType: 'business' });
  database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => {
    const failedUsageId = database.beginProviderUsage('server_voice', 'openai');
    database.finishProviderUsage(failedUsageId, { provider: 'openai', durationMs: 1_000, succeeded: false, errorCode: 'TEST_FAILURE' });
    assert.equal(database.commercialStatus(workspace.id).usage.smartVoiceRequests, 0);
    for (let index = 0; index < 30; index += 1) {
      const usageId = database.beginProviderUsage('server_voice', 'openai');
      database.finishProviderUsage(usageId, { provider: 'openai', durationMs: 1_000 });
    }
    assert.throws(() => database.beginProviderUsage('server_voice', 'openai'), (error) => error.code === 'PLAN_QUOTA_EXCEEDED' && /Chrome.*دستی/.test(error.message));
    const ids = database.insertTransactions({ transcript: 'ثبت دستی بعد از سهمیه', transactions: [{ amount: 120_000, type: 'income', category: 'فروش', rawText: 'ثبت دستی بعد از سهمیه', source: 'text' }] });
    assert.equal(ids.length, 1);
  });
});

test('builds a traceable month package and keeps collaboration auditable', () => inPrimary(() => {
  database.insertTransactions({ transcript: 'فروش مرداد', transactions: [{ amount: 1_200_000, type: 'income', category: 'فروش', rawText: 'فروش مرداد', occurredAt: '2026-08-10T09:00:00.000Z' }] });
  database.saveReceipt({ buffer: Buffer.from('receipt'), fileName: 'open.jpg', mimeType: 'image/jpeg', amount: 450_000, type: 'expense', category: 'مواد و کالا', status: 'review' });
  database.closeDay({ day: '2026-08-10', countedCash: 100, note: '' });
  const request = database.createCollaborationRequest({ entityType: 'general', question: 'این فروش مربوط به کدام پروژه است؟', priority: 'urgent' });
  const packageData = database.monthlyAccountantPackage('2026-08', new Date('2026-08-20T12:00:00.000Z'));
  assert.equal(packageData.summary.transactionCount, 1);
  assert.equal(packageData.summary.incompleteReceipts, 1);
  assert.equal(packageData.checklist.ready, false);
  assert.equal(packageData.manifest.algorithm, 'sha256');
  assert.equal(packageData.manifest.digest.length, 64);
  assert.equal(packageData.manifest.receiptImagesIncluded, false);
  assert.equal(packageData.sections.openRequests[0].id, request.id);
  const persianPackage = database.monthlyAccountantPackage('1405-05', new Date('2026-08-20T12:00:00.000Z'));
  assert.equal(persianPackage.scope.periodType, 'persian');
  assert.equal(persianPackage.scope.period, '1405-05');
  assert.equal(persianPackage.sections.transactions.some((item) => item.rawText === 'فروش مرداد'), true);
  assert.equal(database.answerCollaborationRequest(request.id, 'پروژه آبان').status, 'answered');
  assert.equal(database.resolveCollaborationRequest(request.id).status, 'resolved');
}));

test('records real pilot check-ins and isolates the accountant inbox by workspace', () => {
  inPrimary(() => {
    database.savePilotCheckin({ weekStart: '2026-08-24', respondentType: 'owner', savedMinutes: 45, errorCount: 1, willingnessToPay: 'yes', planInterest: 'professional', friction: 'رسید تار بود' });
    const dashboard = database.pilotWorkspaceDashboard(new Date('2026-08-28T12:00:00.000Z'));
    assert.equal(dashboard.savedMinutes, 45);
    assert.equal(dashboard.reportedErrors, 1);
    assert.equal(dashboard.willingnessToPay, 'yes');
  });
  const second = database.createWorkspace(owner.id, { name: 'دفتر پایلوت دوم', profileType: 'business' });
  database.runInWorkspace(second.id, { role: 'owner', userId: owner.id }, () => {
    assert.equal(database.listCollaborationRequests().length, 0);
    database.createCollaborationRequest({ entityType: 'general', question: 'سؤال مخصوص دفتر دوم' });
    assert.equal(database.listCollaborationRequests().length, 1);
  });
  inPrimary(() => assert.equal(database.listCollaborationRequests().some((item) => item.question.includes('دفتر دوم')), false));
});

test('includes collaboration and usage records in portable backup data', () => inPrimary(() => {
  const snapshot = database.financialBackupSnapshot({ id: 'primary' });
  assert.ok(Array.isArray(snapshot.tables.provider_usage));
  assert.ok(Array.isArray(snapshot.tables.collaboration_requests));
  assert.ok(Array.isArray(snapshot.tables.pilot_checkins));
}));

test.after(() => {
  const workspaceIds = database.allWorkspaces().filter((item) => item.id !== 'primary').map((item) => item.id);
  database.closeWorkspaceDatabases();
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
  for (const workspaceId of workspaceIds) {
    const tenantPath = resolve(dirname(databasePath), 'workspaces', `${workspaceId}.sqlite`);
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${tenantPath}${suffix}`, { force: true });
  }
});
