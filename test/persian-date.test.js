import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDateMention, persianMonthRange, persianToISO, todayPersian } from '../shared/persianDate.js';

const TZ = 'Asia/Tehran';
const persian = (iso) => {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}/${part('month')}/${part('day')}`;
};

test('تبدیل شمسی به میلادی با تقویم واقعی مطابقت دارد', () => {
  const cases = [
    [1405, 6, 2], [1405, 1, 1], [1404, 12, 29], [1403, 12, 30], [1399, 12, 30],
    [1404, 7, 1], [1404, 10, 15], [1400, 5, 31],
  ];
  for (const [year, month, day] of cases) {
    const iso = persianToISO(year, month, day, TZ);
    assert.ok(iso, `${year}/${month}/${day} تبدیل نشد`);
    assert.equal(persian(iso), `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`);
  }
});

test('تاریخ ناموجود ساخته نمی‌شود', () => {
  // ۱۴۰۴ کبیسه نیست، پس ۳۰ اسفند ندارد.
  assert.equal(persianToISO(1404, 12, 30, TZ), null);
  assert.equal(persianToISO(1405, 13, 1, TZ), null);
  assert.equal(persianToISO(1405, 7, 31, TZ), null);
  assert.equal(persianToISO(1405, 0, 5, TZ), null);
});

test('رفت و برگشت هزار روز پیاپی بدون خطا', () => {
  let cursor = Date.UTC(2024, 0, 1, 8, 30);
  for (let index = 0; index < 1_000; index += 1) {
    const token = persian(new Date(cursor).toISOString());
    const [year, month, day] = token.split('/').map(Number);
    assert.equal(persian(persianToISO(year, month, day, TZ)), token, `روز ${token} برنگشت`);
    cursor += 86_400_000;
  }
});

// امروزِ فرضی: ۱۴۰۵/۰۶/۰۶
const NOW = new Date(persianToISO(1405, 6, 6, TZ));
const on = (text, options) => {
  const found = extractDateMention(text, { now: NOW, timeZone: TZ, ...options });
  return found ? persian(found.iso) : null;
};

test('واژه‌های نسبی روی روز درست می‌نشینند', () => {
  assert.equal(on('امروز دو میلیون فروختم'), '1405/06/06');
  assert.equal(on('دیروز دو میلیون فروختم'), '1405/06/05');
  assert.equal(on('پریروز دو میلیون فروختم'), '1405/06/04');
  assert.equal(on('هفتهٔ پیش اجاره دادم'), '1405/05/30');
});

// «سه روز پیش» تا امروز بی‌صدا روی امروز می‌نشست.
test('شمارش گفتاری و عددی روز، هفته و ماه', () => {
  assert.equal(on('سه روز پیش پنج میلیون خرید کردم'), '1405/06/03');
  assert.equal(on('۵ روز قبل حقوق دادم'), '1405/06/01');
  assert.equal(on('دو هفته پیش فاکتور زدم'), '1405/05/23');
  // ماه تقویمی است نه سی روز: همان روزِ ماه قبل.
  assert.equal(on('یک ماه پیش اجاره دادم'), '1405/05/06');
});

test('روز و ماه گفته‌شده دقیقاً همان روز را می‌گیرد', () => {
  assert.equal(on('دوم شهریور سه میلیون فروختم'), '1405/06/02');
  assert.equal(on('۲۵ مرداد قبض دادم'), '1405/05/25');
  assert.equal(on('بیست و یکم تیر حقوق دادم'), '1405/04/21');
  assert.equal(on('اول فروردین افتتاحیه'), '1405/01/01');
  assert.equal(on('سی ام دی تسویه کردم'), '1404/10/30', 'دی بعد از شهریور است، پس سال گذشته');
});

// کسی رویداد مالی آینده را ثبت نمی‌کند؛ اسفند در شهریور یعنی سال گذشته.
test('ماهی که هنوز نرسیده، به سال گذشته نسبت داده می‌شود', () => {
  assert.equal(on('بیست و پنجم اسفند پاداش دادم'), '1404/12/25');
  assert.equal(on('دهم مهر فروش داشتم'), '1404/07/10');
});

test('برای سررسید آینده، ترجیح گذشته خاموش می‌شود', () => {
  assert.equal(on('چک برای دهم مهر', { preferPast: false }), '1405/07/10');
});

test('سال صریح بر حدس مقدم است', () => {
  assert.equal(on('دوم شهریور ۱۴۰۳ سه میلیون'), '1403/06/02');
  assert.equal(on('۱۴۰۴/۱۲/۲۹ تسویه شد'), '1404/12/29');
  assert.equal(on('1403-01-05 خرید'), '1403/01/05');
});

test('متن بدون تاریخ، تاریخ نمی‌سازد', () => {
  assert.equal(on('دو میلیون بابت تبلیغات دادم'), null);
  assert.equal(on('کد حساب هزار و دویست'), null);
  assert.equal(on(''), null);
});

// مبلغ نباید به‌عنوان تاریخ خوانده شود و برعکس.
test('مبلغ چهاررقمی با تاریخ اشتباه گرفته نمی‌شود', () => {
  assert.equal(on('هزار و دویست تومان دادم'), null);
  assert.equal(on('شماره فاکتور ۱۴۰۵'), null);
});

test('برچسب تاریخ برای نمایش به کاربر ساخته می‌شود', () => {
  assert.equal(extractDateMention('سه روز پیش خرید', { now: NOW, timeZone: TZ }).label, '3 روز پیش');
  assert.equal(extractDateMention('دیروز خرید', { now: NOW, timeZone: TZ }).label, 'دیروز');
  assert.equal(extractDateMention('دوم شهریور خرید', { now: NOW, timeZone: TZ }).kind, 'inferred-year');
  assert.equal(extractDateMention('۱۴۰۴/۰۶/۰۲ خرید', { now: NOW, timeZone: TZ }).kind, 'explicit');
});

test('امروزِ شمسی از ساعت سیستم درست خوانده می‌شود', () => {
  assert.deepEqual(todayPersian(NOW, TZ), { year: 1405, month: 6, day: 6 });
});

test('بازهٔ ماه شمسی از نیمه‌شب اول ماه تا نیمه‌شب اول ماه بعد است', () => {
  const shahrivar = persianMonthRange(1405, 6, TZ);
  assert.equal(shahrivar.month, '1405-06');
  assert.equal(persian(shahrivar.from), '1405/06/01');
  // یک میلی‌ثانیه پیش از پایان، هنوز داخل همان ماه است.
  assert.equal(persian(shahrivar.to), '1405/06/31');
  assert.equal(persian(shahrivar.toExclusive), '1405/07/01');

  // اسفند در سال کبیسه ۳۰ روز و در سال عادی ۲۹ روز است؛ قاعده از تقویم پلتفرم
  // می‌آید، نه از حفظ.
  const leap = persianMonthRange(1403, 12, TZ);
  assert.equal(persian(leap.to), '1403/12/30');
  const ordinary = persianMonthRange(1404, 12, TZ);
  assert.equal(persian(ordinary.to), '1404/12/29');
});

// سررسید تقریباً همیشه آینده است و کاربر آن را نسبی می‌گوید. بدون اینها تاریخ
// سررسید عملاً هیچ‌وقت فهمیده نمی‌شد.
test('تاریخ‌های رو به آینده فهمیده می‌شوند', () => {
  const now = new Date(persianToISO(1405, 6, 16, TZ));
  const at = (text) => extractDateMention(text, { now, timeZone: TZ, preferPast: false });

  assert.equal(persian(at('سه روز دیگه').iso), '1405/06/19');
  assert.equal(persian(at('۱۰ روز دیگر').iso), '1405/06/26');
  assert.equal(persian(at('هفته بعد').iso), '1405/06/23');
  assert.equal(persian(at('دو هفته دیگه').iso), '1405/06/30');

  // «ماه بعد» یعنی همان روزِ ماه بعد؛ «اول ماه بعد» یعنی روز یک.
  assert.equal(persian(at('ماه بعد').iso), '1405/07/16');
  assert.equal(persian(at('اول ماه بعد').iso), '1405/07/01');

  // طول ماه از تقویم پرسیده می‌شود: شهریور ۳۱ روز است.
  assert.equal(persian(at('آخر ماه').iso), '1405/06/31');
});

test('روزی که در ماه بعد وجود ندارد، روی آخرین روز همان ماه می‌نشیند', () => {
  // شش ماه اول ۳۱ روزند و پنج ماه بعد ۳۰ روز؛ «۳۱ شهریور، ماه بعد» تاریخ
  // ناموجود «۳۱ مهر» نمی‌سازد.
  const now = new Date(persianToISO(1405, 6, 31, TZ));
  const next = extractDateMention('ماه بعد', { now, timeZone: TZ, preferPast: false });
  assert.equal(persian(next.iso), '1405/07/30');
});

// گذشته و آینده نباید همدیگر را خراب کنند.
test('عبارت‌های گذشته دست‌نخورده می‌مانند', () => {
  const now = new Date(persianToISO(1405, 6, 16, TZ));
  const at = (text) => extractDateMention(text, { now, timeZone: TZ });
  assert.equal(persian(at('سه روز پیش').iso), '1405/06/13');
  assert.equal(persian(at('هفته پیش').iso), '1405/06/09');
  assert.equal(persian(at('دیروز').iso), '1405/06/15');
});

// «دیگه» با نام ماه «دی» تطبیق می‌خورد و «یک ماه دیگه» را به اول دی می‌برد —
// یعنی سررسید چک سه ماه جلوتر از چیزی که کاربر گفته.
test('نام ماه مرز راست دارد و درون واژهٔ دیگر پیدا نمی‌شود', () => {
  const now = new Date(persianToISO(1405, 6, 21, TZ));
  const future = (text) => {
    const found = extractDateMention(text, { now, timeZone: TZ, preferPast: false });
    return found ? persian(found.iso) : null;
  };
  assert.equal(future('یک ماه دیگه'), '1405/07/21');
  assert.equal(future('دو ماه دیگه'), '1405/08/21');
  // «مهربان» نباید «مهر» خوانده شود.
  assert.equal(future('پنج مهربان'), null);
  // ولی «شهریورماه» باید همچنان بخورد.
  assert.equal(future('۱۰ شهریورماه'), '1405/06/10');
  assert.equal(future('بیستم مهرماه'), '1405/07/20');
});

// ماه‌های شمسی ۲۹ تا ۳۱ روزند؛ شمردن ماه به‌صورت ۳۰ روز، «یک ماه دیگه» را با
// «ماه بعد» یک روز اختلاف می‌داد و سررسید در ماه اشتباه می‌نشست.
test('شمارش ماه تقویمی است، نه سی‌روزه', () => {
  const now = new Date(persianToISO(1405, 6, 21, TZ));
  const on = (text, preferPast) => persian(extractDateMention(text, { now, timeZone: TZ, preferPast }).iso);
  assert.equal(on('یک ماه دیگه', false), on('ماه بعد', false));
  assert.equal(on('یک ماه پیش', true), on('ماه پیش', true));
  assert.equal(on('یک ماه دیگه', false), '1405/07/21');
  assert.equal(on('یک ماه پیش', true), '1405/05/21');
});

test('روزی که در ماه مقصد نیست، روی آخرین روز همان ماه می‌نشیند', () => {
  // شهریور ۳۱ روز دارد ولی مهر ۳۰ روز.
  const endOfMonth = new Date(persianToISO(1405, 6, 31, TZ));
  const found = extractDateMention('یک ماه دیگه', { now: endOfMonth, timeZone: TZ, preferPast: false });
  assert.equal(persian(found.iso), '1405/07/30');
});

test('شمارش ماه از مرز سال هم درست رد می‌شود', () => {
  const endOfYear = new Date(persianToISO(1405, 12, 29, TZ));
  const found = extractDateMention('یک ماه دیگه', { now: endOfYear, timeZone: TZ, preferPast: false });
  assert.equal(persian(found.iso), '1406/01/29');
});
