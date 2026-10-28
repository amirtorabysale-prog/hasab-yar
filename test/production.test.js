// ثبت تولید: خانوادهٔ رویداد
//   - تولید با فرمول (پیشنهاد از فرمول پارسیانِ همان نام، مقیاس با تعداد) و بی‌فرمول (اجزای دستی)؛
//   - مقدار واقعی مصرف با فرمول فرق دارد: همان مقدار واقعی ثبت می‌شود؛
//   - مواد به میانگین موزون بیرون، محصول با همان ارزش درون؛ سند فقط میان حساب‌های موجودی؛
//     نه پول، نه درآمد، نه هزینه؛
//   - منفی‌ها: کمبود جزء، بی‌جزء، محصول جزء خودش، مواد بی‌بها، تعداد صفر — هیچ‌کدام چیزی نمی‌نویسند.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('production');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'production-owner';
process.env.ADMIN_PASSWORD = 'production-strong-password-4417';
const database = await import(`../server/db.js?production=${process.pid}`);
const accounting = await import(`../server/accounting.js?production=${process.pid}`);
const { ensureParsianExtrasSchema } = await import('../server/parsianExtras.js');
database.ensureAdmin();
const owner = database.authenticateUser('production-owner', 'production-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'تولیدی نمونه', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();
test.after(() => removeTempDatabase(databasePath));

const product = (name) => db().prepare('SELECT id,stock,inventory_value AS value,average_cost AS average FROM products WHERE name=?').get(name);
const kindNet = (type) => db().prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net FROM journal_lines
  JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.type=?`).get(type).net;

test('تولید با فرمول: پیشنهاد از فرمول، مقدار واقعی ثبت، ارزش محصول = بهای مواد به میانگین', () => {
  inWorkspace(() => {
    database.saveProduct({ name: 'گرانول', unit: 'کیلو', stock: 100, buyPrice: 50_000 });
    database.saveProduct({ name: 'رنگدانه', unit: 'کیلو', stock: 10, buyPrice: 400_000 });
    database.saveProduct({ name: 'سطل ۲۰ لیتری', unit: 'عدد' });
    ensureParsianExtrasSchema(db());
    const formula = db().prepare(`INSERT INTO parsian_production_formulas (file_sha256,product_code,product_name,component_code,component_name,unit,quantity,per_units,unit_price)
      VALUES ('sha',1,'سطل ۲۰ لیتری',?,?,'کیلو',?,?,NULL)`);
    formula.run(2, 'گرانول', 1.2, 1);
    formula.run(3, 'رنگدانه', 0.5, 10); // ۰٫۰۵ برای هر واحد
    const bucket = product('سطل ۲۰ لیتری');
    const plan = database.productionPlan({ productId: bucket.id, quantity: 20 });
    assert.equal(plan.fromFormula, true);
    assert.deepEqual(plan.components.map((item) => [item.name, item.quantity]).sort(), [['رنگدانه', 1], ['گرانول', 24]]);

    const income = kindNet('income');
    const expense = kindNet('expense');
    const assets = kindNet('asset');
    // مصرف واقعی گرانول ۲۵، نه ۲۴.
    const run = database.recordProduction({ productId: bucket.id, quantity: 20, components: [
      { productId: product('گرانول').id, quantity: 25 }, { productId: product('رنگدانه').id, quantity: 1 },
    ] });
    assert.equal(run.value, 25 * 50_000 + 400_000);
    assert.equal(run.unitCost, Math.round(run.value / 20));
    assert.deepEqual({ ...product('سطل ۲۰ لیتری') }, { id: bucket.id, stock: 20, value: run.value, average: run.unitCost });
    assert.deepEqual([product('گرانول').stock, product('گرانول').value], [75, 75 * 50_000]);
    assert.equal(kindNet('income'), income);
    assert.equal(kindNet('expense'), expense);
    assert.equal(kindNet('asset'), assets, 'فقط جابه‌جایی میان موجودی‌ها');
    const lines = db().prepare('SELECT debit,credit FROM journal_lines WHERE entry_id=?').all(run.entryId);
    assert.equal(lines.length, 3);
    assert.equal(accounting.trialBalance(db()).balanced, true);
    assert.equal(database.listProductionRuns()[0].id, run.id);
  });
});

test('تولید بی‌فرمول با اجزای دستی؛ منفی‌ها چیزی نمی‌نویسند', () => {
  inWorkspace(() => {
    database.saveProduct({ name: 'درب سطل', unit: 'عدد' });
    database.saveProduct({ name: 'ضایعات بی‌بها', unit: 'کیلو', stock: 5, buyPrice: 0 });
    const lid = product('درب سطل');
    assert.equal(database.productionPlan({ productId: lid.id, quantity: 5 }).fromFormula, false);
    const entries = () => db().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
    const before = entries();
    const granule = product('گرانول');
    assert.throws(() => database.recordProduction({ productId: lid.id, quantity: 5, components: [{ productId: granule.id, quantity: 500 }] }), { code: 'PRODUCTION_SHORTAGE' });
    assert.throws(() => database.recordProduction({ productId: lid.id, quantity: 5, components: [] }), { code: 'PRODUCTION_NO_COMPONENTS' });
    assert.throws(() => database.recordProduction({ productId: lid.id, quantity: 5, components: [{ productId: lid.id, quantity: 1 }] }), /جزء مصرفی خودش/);
    assert.throws(() => database.recordProduction({ productId: lid.id, quantity: 0, components: [{ productId: granule.id, quantity: 1 }] }), /بیشتر از صفر/);
    assert.throws(() => database.recordProduction({ productId: lid.id, quantity: 5, components: [{ productId: product('ضایعات بی‌بها').id, quantity: 1 }] }), { code: 'PRODUCTION_NO_COST' });
    assert.equal(entries(), before);
    assert.equal(product('ضایعات بی‌بها').stock, 5, 'خطا همه‌چیز را برمی‌گرداند');
    const run = database.recordProduction({ productId: lid.id, quantity: 5, components: [{ productId: granule.id, quantity: 2 }] });
    assert.equal(run.value, 100_000);
    assert.equal(product('درب سطل').stock, 5);
  });
});
