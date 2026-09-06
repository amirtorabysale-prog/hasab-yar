import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('parsian');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'parsian-owner';
process.env.ADMIN_PASSWORD = 'Parsian-Long-Passphrase-4417';

const database = await import(`../server/db.js?parsian=${process.pid}`);
const accounting = await import(`../server/accounting.js?parsian=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('parsian-owner', 'Parsian-Long-Passphrase-4417');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت پارسیان', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const TARGET = 'parsian-review-csv';

test('filling from the chart is refused before any chart mapping exists', () => {
  inWorkspace(() => {
    assert.throws(() => database.fillTransferMappingsFromChart(TARGET), (error) => error.code === 'CHART_MAPPING_EMPTY');
  });
});

test('the Parsian export starts blocked on target codes', () => {
  inWorkspace(() => {
    database.insertTransactions({
      transcript: 'فروش نقدی',
      transactions: [{ amount: 3_000_000, type: 'income', category: 'فروش', rawText: 'فروش نقدی' }],
    });
    database.installChartTemplate();
    database.applyChartSuggestions();

    const overview = database.accountingTransferOverview('', TARGET);
    const mappingCheck = overview.readiness.checks.find((item) => item.id === 'mappings');
    assert.equal(mappingCheck.passed, false);
    assert.ok(mappingCheck.count > 0);
    assert.equal(overview.readiness.missingMappings.length, mappingCheck.count);
    assert.equal(overview.readiness.ready, false);
  });
});

test('one call fills every target code from the office chart', () => {
  inWorkspace(() => {
    const before = database.accountingTransferOverview('', TARGET).readiness;
    const result = database.fillTransferMappingsFromChart(TARGET);
    assert.ok(result.filled > 0);
    assert.equal(result.kept, 0);

    const after = database.accountingTransferOverview('', TARGET).readiness;
    assert.equal(after.checks.find((item) => item.id === 'mappings').passed, true);
    assert.equal(after.missingMappings.length, 0);
    assert.ok(before.missingMappings.length > 0);

    // کد مقصد باید دقیقاً همان کد معین کدینگ دفتر باشد.
    const cash = after.accounts.find((item) => item.mapping?.targetCode === '1101');
    assert.ok(cash, 'حساب صندوق باید کد مقصد ۱۱۰۱ گرفته باشد');
  });
});

test('a hand written target code is never overwritten by accident', () => {
  inWorkspace(() => {
    const account = database.accountingTransferOverview('', TARGET).readiness.accounts[0];
    database.saveAccountingTransferMapping({
      targetSystem: TARGET, ledgerAccountId: account.id, targetCode: '999999', targetName: 'دستی',
    });
    const result = database.fillTransferMappingsFromChart(TARGET);
    assert.ok(result.kept > 0, 'نگاشت دستی باید دست‌نخورده بماند');

    const kept = database.accountingTransferOverview('', TARGET).readiness.accounts.find((item) => item.id === account.id);
    assert.equal(kept.mapping.targetCode, '999999');
  });
});

test('overwrite is possible but only when asked for explicitly', () => {
  inWorkspace(() => {
    const account = database.accountingTransferOverview('', TARGET).readiness.accounts[0];
    database.fillTransferMappingsFromChart(TARGET, { overwrite: true });
    const replaced = database.accountingTransferOverview('', TARGET).readiness.accounts.find((item) => item.id === account.id);
    assert.notEqual(replaced.mapping.targetCode, '999999');
  });
});

test('the template check still stands on its own and then the export opens', () => {
  inWorkspace(() => {
    const beforeTemplate = database.accountingTransferOverview('', TARGET).readiness;
    assert.equal(beforeTemplate.checks.find((item) => item.id === 'template').passed, false);
    assert.equal(beforeTemplate.ready, false, 'کد مقصد کامل است ولی تأیید قالب هنوز نه');

    database.saveAccountingTransferSettings({
      targetSystem: TARGET, templateName: 'قالب آزمایشی پارسیان ۱۴۰۵', templateVerified: true,
    });

    const ready = database.accountingTransferOverview('', TARGET).readiness;
    assert.equal(ready.checks.find((item) => item.id === 'template').passed, true);
    assert.equal(ready.ready, true, JSON.stringify(ready.checks.filter((item) => !item.passed)));

    const batch = database.createAccountingTransferBatch({ targetSystem: TARGET });
    assert.ok(batch.rowCount > 0);
    // ستون کد مقصد باید واقعاً پر شده باشد، نه خالی.
    const text = database.accountingTransferBatchFile(batch.id).fileData.toString('utf8');
    assert.match(text, /1101/);
    assert.equal(accounting.trialBalance(database.db).balanced, true);
  });
});

test.after(() => removeTempDatabase(databasePath));
