import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonnelBlock, parsePersonnelLine } from '../shared/personnelLine.js';

/**
 * تعریف سریع پرسنل بی صدا: هر تکه از شکل خودش، به هر ترتیب؛ نامشخص حدس زده نمی‌شود.
 * «امروز» آزمون: ۱۰ آبان ۱۴۰۵.
 */
const now = new Date('2026-11-01T08:00:00.000Z');
const line = (text) => parsePersonnelLine(text, { now });

test('یک خط، بی برچسب و بی جداکننده — نمونهٔ خود محصول', () => {
  const { values, wage, unknown, issues } = line('امیرحسین ترابی ۱۲۷۳۹۲۵۳۵۱ تولید تمام‌وقت ۱۸ میلیون ۰۹۱۲۳۴۵۶۷۸۹ متاهل ۲ بچه');
  assert.deepEqual(values, { name: 'امیرحسین ترابی', nationalId: '1273925351', department: 'production', employmentType: 'full', mobile: '09123456789', marital: 'married', children: 2 });
  assert.deepEqual(wage, { amount: 18_000_000, unit: 'toman' });
  assert.deepEqual([unknown, issues], [[], []]);
});

test('ترتیب و شکل‌های دیگر: برچسب، ویرگول، عنوان، تاریخ شمسی و گفتاری، لقب، شبا، بیمه', () => {
  const a = line('آقای علی رضایی، کد ملی 0084575948، از اول مهر ۱۴۰۲، سمت انباردار، حقوق 25000000، مجرد');
  assert.equal(a.values.name, 'علی رضایی');
  assert.equal(a.values.nationalId, '0084575948');
  assert.equal(a.values.jobTitle, 'انباردار');
  assert.equal(a.values.marital, 'single');
  assert.equal(a.values.startDate, '2023-09-23T08:30:00.000Z');
  assert.deepEqual(a.wage, { amount: 25_000_000, unit: 'toman' }, 'عدد بی‌مقیاس پس از «حقوق» مزد است');

  const b = line('مریم احمدی «خانم مهندس» اداری پاره وقت IR820540102680020817909002 بیمه ۱۲۳۴۵۶۷۸ بدون بچه');
  assert.deepEqual(b.values, { name: 'مریم احمدی', nickname: 'خانم مهندس', department: 'admin', employmentType: 'part', iban: 'IR820540102680020817909002', insuranceNumber: '12345678', children: 0 });

  const c = line('۰۹۱۲ ۳۴۵ ۶۷۸۹ حسن کریمی ۱۴۰۳/۰۲/۱۰ ساعتی ۲۰۰ هزار تومان لقب اوستا');
  assert.equal(c.values.name, 'حسن کریمی', 'نام لازم نیست اول بیاید');
  assert.equal(c.values.mobile, '09123456789');
  assert.equal(c.values.employmentType, 'hourly');
  assert.equal(c.values.nickname, 'اوستا');
  assert.deepEqual(c.wage, { amount: 200_000, unit: 'toman' });

  assert.deepEqual(line('سید محمد علی حسینی فروش ۱۸۰ میلیون ریال').wage, { amount: 180_000_000, unit: 'rial' });
  assert.equal(line('سید محمد علی حسینی فروش').values.name, 'سید محمد علی حسینی');
  assert.equal(line('رضا +98 912 345 6789').values.mobile, '09123456789');
  assert.equal(line('رضا یک میلیون و دویست هزار').wage.amount, 1_200_000);
  assert.equal(line('رضا سه تا بچه').values.children, 3);
});

test('منفی: کد ملی نامعتبر، عدد بی‌برچسب، دو مبلغ، تاریخ آینده و بی نام حدس زده نمی‌شوند', () => {
  const invalid = line('رضا کریمی 1234567890 ۱۵ میلیون');
  assert.equal(invalid.values.nationalId, undefined);
  assert.match(invalid.issues[0].message, /کد ملی معتبری نیست/);

  const bare = line('علی ۱۲۳۴۵۶');
  assert.deepEqual(bare.unknown, ['123456'], 'عدد بی‌برچسب بیمه یا مزد حدس زده نمی‌شود');
  assert.equal(bare.values.insuranceNumber, undefined);
  assert.equal(bare.wage, null);

  // عدد بی‌برچسبِ پس از مبلغ به مزد نمی‌چسبد (دیدهٔ مرورگر: «۱۸ میلیون … ۴۴۵۵۶۶» → ۱۸٬۴۴۵٬۵۶۶).
  const tail = line('امیرحسین ترابی ۱۲۷۳۹۲۵۳۵۱ تولید تمام‌وقت ۱۸ میلیون ۰۹۱۲۳۴۵۶۷۸۹ متاهل ۲ بچه ۴۴۵۵۶۶');
  assert.deepEqual(tail.wage, { amount: 18_000_000, unit: 'toman' });
  assert.deepEqual(tail.unknown, ['445566']);

  const twice = line('علی ۱۸ میلیون ۲۰ میلیون');
  assert.equal(twice.wage, null);
  assert.match(twice.issues[0].message, /دو مبلغ/);

  assert.equal(line('علی ۱۴۰۶/۰۱/۰۱').issues[0].field, 'startDate');
  assert.equal(line('۰۰۸۴۵۷۵۹۴۸ تولید').values.name, undefined, 'بی نام، نام ساخته نمی‌شود');
  assert.equal(line('علی IR820540102680020817909003').issues[0].field, 'iban');
});

test('چند خط بی عنوان: هر خط یک نفر', () => {
  const { rows, columns } = parsePersonnelBlock('علی رضایی 0084575948 تولید\nحسن کریمی ۱۸ میلیون\n\nمریم 1111111111', { now });
  assert.equal(columns, null);
  assert.deepEqual(rows.map((row) => [row.line, row.values.name]), [[1, 'علی رضایی'], [2, 'حسن کریمی'], [3, 'مریم']]);
  assert.equal(rows[2].issues[0].field, 'nationalId');
});

test('اکسل با عنوان ستون: تب یا ویرگول، مزد ریالی از عنوان، خانهٔ نامعتبر گزارش می‌شود', () => {
  const tab = parsePersonnelBlock('نام\tکد ملی\tموبایل\tحقوق (ریال)\tبخش\nعلی رضایی\t0084575948\t09123456789\t180000000\tتولید\nحسن کریمی\t1111111111\t0912\t\tاداری', { now });
  assert.deepEqual(tab.columns.map((column) => column.field), ['name', 'nationalId', 'mobile', 'baseWage', 'department']);
  assert.deepEqual(tab.rows[0].values, { name: 'علی رضایی', nationalId: '0084575948', mobile: '09123456789', department: 'production' });
  assert.deepEqual(tab.rows[0].wage, { amount: 180_000_000, unit: 'rial' });
  assert.deepEqual(tab.rows[1].issues.map((issue) => issue.field), ['nationalId', 'mobile']);
  assert.equal(tab.rows[1].line, 3);

  const comma = parsePersonnelBlock('نام و نام خانوادگی,شبا,تاریخ شروع,حقوق\nمریم احمدی,IR820540102680020817909002,1402/07/01,25000000', { now });
  assert.equal(comma.rows[0].values.iban, 'IR820540102680020817909002');
  assert.equal(comma.rows[0].values.startDate, '2023-09-23T08:30:00.000Z');
  assert.deepEqual(comma.rows[0].wage, { amount: 25_000_000, unit: 'toman' });
});
