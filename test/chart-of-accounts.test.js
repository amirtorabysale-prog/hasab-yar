import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHART_TEMPLATE, chartCodeIsValid, normalizeChartCode, normalizeChartLevel, normalizeChartType,
  parseChartCsv, suggestChartAccount, validateChartRows,
} from '../server/chartOfAccounts.js';
import { minimumRoleForRequest } from '../server/access.js';

test('account codes accept Persian digits and common separators', () => {
  assert.equal(normalizeChartCode('۱۱۰۱'), '1101');
  assert.equal(normalizeChartCode('11-01'), '1101');
  assert.equal(normalizeChartCode(' 11.01 '), '1101');
  assert.equal(chartCodeIsValid('1101'), true);
  assert.equal(chartCodeIsValid('11a1'), false);
  assert.equal(chartCodeIsValid(''), false);
});

test('Persian level and type words are understood', () => {
  assert.equal(normalizeChartLevel('گروه'), 'group');
  assert.equal(normalizeChartLevel('کل'), 'general');
  assert.equal(normalizeChartLevel('معین'), 'subsidiary');
  assert.equal(normalizeChartLevel('چیز دیگر'), null);
  assert.equal(normalizeChartType('دارایی'), 'asset');
  assert.equal(normalizeChartType('بدهی'), 'liability');
  assert.equal(normalizeChartType('هزینه'), 'expense');
  assert.equal(normalizeChartType(''), null);
});

test('a well formed chart passes and comes back parent-first', () => {
  const { accounts, errors } = validateChartRows([
    { code: '1101', name: 'صندوق', level: 'معین', parentCode: '11', type: 'دارایی' },
    { code: '11', name: 'نقد و بانک', level: 'کل', parentCode: '1', type: 'دارایی' },
    { code: '1', name: 'دارایی جاری', level: 'گروه', parentCode: '', type: 'دارایی' },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(accounts.map((item) => item.code), ['1', '11', '1101']);
  assert.equal(accounts.at(-1).postable, true);
  assert.equal(accounts[0].postable, false);
  assert.equal(accounts.at(-1).normalSide, 'debit');
});

test('a child code that does not continue its parent is rejected by row number', () => {
  const { errors } = validateChartRows([
    { rowNumber: 2, code: '1', name: 'دارایی', level: 'گروه', parentCode: '', type: 'دارایی' },
    { rowNumber: 3, code: '11', name: 'نقد', level: 'کل', parentCode: '1', type: 'دارایی' },
    { rowNumber: 4, code: '9901', name: 'صندوق', level: 'معین', parentCode: '11', type: 'دارایی' },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rowNumber, 4);
  assert.match(errors[0].message, /باید با کد والد 11 شروع شود/);
});

test('level nesting, missing parents, duplicates and type drift are all caught', () => {
  const { errors } = validateChartRows([
    { rowNumber: 2, code: '1', name: 'دارایی', level: 'گروه', parentCode: '', type: 'دارایی' },
    { rowNumber: 3, code: '11', name: 'نقد', level: 'کل', parentCode: '1', type: 'دارایی' },
    { rowNumber: 4, code: '11', name: 'تکراری', level: 'کل', parentCode: '1', type: 'دارایی' },
    { rowNumber: 5, code: '12', name: 'بدون والد', level: 'کل', parentCode: '99', type: 'دارایی' },
    { rowNumber: 6, code: '111', name: 'نوع ناهمخوان', level: 'معین', parentCode: '11', type: 'هزینه' },
    { rowNumber: 7, code: '112', name: 'والد اشتباه', level: 'معین', parentCode: '1', type: 'دارایی' },
  ]);
  const messages = Object.fromEntries(errors.map((item) => [item.rowNumber, item.message]));
  assert.match(messages[4], /تکراری/);
  assert.match(messages[5], /والد با کد 99/);
  assert.match(messages[6], /نوع حساب با والد/);
  assert.match(messages[7], /والد معین باید کل باشد/);
});

test('a group is not allowed to have a parent', () => {
  const { errors } = validateChartRows([
    { rowNumber: 2, code: '1', name: 'الف', level: 'گروه', parentCode: '', type: 'دارایی' },
    { rowNumber: 3, code: '2', name: 'ب', level: 'گروه', parentCode: '1', type: 'دارایی' },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /گروه نباید والد داشته باشد/);
});

test('the shipped default template is itself a valid chart', () => {
  const { errors, accounts } = validateChartRows(DEFAULT_CHART_TEMPLATE.map((item) => ({ ...item })));
  assert.deepEqual(errors, []);
  assert.equal(accounts.length, DEFAULT_CHART_TEMPLATE.length);
  assert.ok(accounts.filter((item) => item.postable).length >= 15);
});

test('a Persian CSV with Persian headers is read column by column', () => {
  const { rows } = parseChartCsv([
    'کد,نام حساب,سطح,کد والد,نوع',
    '۱,دارایی‌های جاری,گروه,,دارایی',
    '۱۱,نقد و بانک,کل,۱,دارایی',
    '۱۱۰۱,"صندوق, شعبه مرکزی",معین,۱۱,دارایی',
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.equal(rows[2].name, 'صندوق, شعبه مرکزی');
  const { accounts, errors } = validateChartRows(rows);
  assert.deepEqual(errors, []);
  assert.deepEqual(accounts.map((item) => item.code), ['1', '11', '1101']);
});

test('semicolon files and English headers work too', () => {
  const { rows, separator } = parseChartCsv('code;name;level;parent;type\n1;Assets;group;;asset\n11;Cash;general;1;asset');
  assert.equal(separator, ';');
  assert.equal(rows.length, 2);
  assert.deepEqual(validateChartRows(rows).errors, []);
});

test('a file without the required columns fails loudly instead of importing nothing', () => {
  assert.throws(() => parseChartCsv('foo,bar\n1,2'), /ستون/);
  assert.throws(() => parseChartCsv('کد,نام,سطح,نوع'), /سرستون و حداقل یک ردیف/);
});

test('internal accounts are suggested onto the chart role that matches them', () => {
  const chart = DEFAULT_CHART_TEMPLATE.map((item) => ({ ...item, level: item.level, postable: item.level === 'subsidiary', active: true, id: item.code }));
  const suggest = (account) => suggestChartAccount(account, chart)?.code || null;
  assert.equal(suggest({ sourceKind: 'customer-receivable', type: 'asset', name: 'حساب دریافتنی — آبان' }), '1201');
  assert.equal(suggest({ sourceKind: 'vendor-payable', type: 'liability', name: 'حساب پرداختنی — پارس' }), '3101');
  assert.equal(suggest({ sourceKind: 'cogs-product', type: 'expense', name: 'بهای تمام‌شده — چای' }), '7101');
  assert.equal(suggest({ sourceKind: 'inventory-product', type: 'asset', name: 'موجودی کالا — چای' }), '1301');
  assert.equal(suggest({ sourceKind: 'system', sourceKey: 'output-tax', type: 'liability', name: 'مالیات فروش' }), '3201');
  assert.equal(suggest({ sourceKind: 'system', sourceKey: 'input-tax', type: 'asset', name: 'اعتبار خرید' }), '1402');
  assert.equal(suggest({ sourceKind: 'system', sourceKey: 'opening-equity', type: 'equity', name: 'سرمایه' }), '5101');
});

test('a cash account and a bank account are told apart by name', () => {
  const chart = DEFAULT_CHART_TEMPLATE.map((item) => ({ ...item, postable: item.level === 'subsidiary', active: true, id: item.code }));
  assert.equal(suggestChartAccount({ sourceKind: 'operational-account', type: 'asset', name: 'صندوق نقدی' }, chart).code, '1101');
  assert.equal(suggestChartAccount({ sourceKind: 'operational-account', type: 'asset', name: 'بانک ملت' }, chart).code, '1102');
});

test('nothing is suggested when the chart has no postable account of that type', () => {
  assert.equal(suggestChartAccount({ sourceKind: 'expense-category', type: 'expense', name: 'اجاره' }, []), null);
});

test('chart master data sits behind the manager role, not daily entry', () => {
  assert.equal(minimumRoleForRequest('POST', '/chart/import'), 'manager');
  assert.equal(minimumRoleForRequest('PUT', '/chart/mappings/abc'), 'manager');
  assert.equal(minimumRoleForRequest('POST', '/chart/cost-centers'), 'manager');
  assert.equal(minimumRoleForRequest('GET', '/chart/overview'), 'viewer');
});

// نقش `operating-expense` را فقط یک معین دارد، پس هر دستهٔ هزینه‌ای به ۸۱۰۹
// می‌رفت و در پارسیان اجاره، حمل‌ونقل و قبوض همه در یک حساب کلی جمع می‌شدند.
test('دستهٔ هزینه به معین اختصاصی خودش نگاشت می‌شود، نه به سایر هزینه‌ها', () => {
  const chart = DEFAULT_CHART_TEMPLATE.map((item) => ({ ...item, postable: item.level === 'subsidiary', active: true, id: item.code }));
  const suggest = (name, type = 'expense') => suggestChartAccount({ sourceKind: `${type}-category`, sourceKey: name, type, name }, chart)?.code || null;
  assert.equal(suggest('اجاره'), '8102');
  assert.equal(suggest('حمل‌ونقل'), '8103');
  assert.equal(suggest('قبوض'), '8104');
  assert.equal(suggest('حقوق و دستمزد'), '8101');
  assert.equal(suggest('کسری و ضایعات موجودی'), '8105');
  assert.equal(suggest('فروش', 'income'), '6101');
  assert.equal(suggest('خدمات', 'income'), '6102');
});

test('دستهٔ بدون معین اختصاصی، همچنان به سایر هزینه‌ها می‌افتد', () => {
  const chart = DEFAULT_CHART_TEMPLATE.map((item) => ({ ...item, postable: item.level === 'subsidiary', active: true, id: item.code }));
  const suggest = (name) => suggestChartAccount({ sourceKind: 'expense-category', sourceKey: name, type: 'expense', name }, chart)?.code || null;
  assert.equal(suggest('سایر هزینه‌ها'), '8109');
  // دستهٔ دست‌ساز کاربر کد اختصاصی ندارد و نباید کد جعلی بگیرد.
  assert.equal(suggest('یک دستهٔ دلخواه'), '8109');
});

// معینی که در کدینگ دفتر وجود ندارد نباید پیشنهاد شود؛ نگاشت به کد ناموجود
// یعنی فایل انتقالی که پارسیان ردش می‌کند.
test('کد اختصاصیِ نبود در کدینگ، به نقش عمومی برمی‌گردد', () => {
  const trimmed = DEFAULT_CHART_TEMPLATE
    .filter((item) => !['8102', '8103'].includes(item.code))
    .map((item) => ({ ...item, postable: item.level === 'subsidiary', active: true, id: item.code }));
  const suggest = (name) => suggestChartAccount({ sourceKind: 'expense-category', sourceKey: name, type: 'expense', name }, trimmed)?.code || null;
  assert.equal(suggest('اجاره'), '8109');
  assert.equal(suggest('حمل‌ونقل'), '8109');
});
