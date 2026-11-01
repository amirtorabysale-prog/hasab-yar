import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { appendSpeechSegment } from '../src/lib/liveSpeech.js';
import {
  PERSONNEL_STEPS, splitVoiceCommand, normalizeMobile, personnelCompleteness, readPersonnelAnswer, spokenDigits, validIban, validNationalId, validatePersonnel,
} from '../shared/personnel.js';

/**
 * تعریف پرسنل: خواندن پاسخ هر مرحله از گفتار یا تایپ، کنترل‌ها، و پرونده روی همان «شخص».
 * «امروز» آزمون: ۱۰ آبان ۱۴۰۵.
 */
const now = new Date('2026-11-01T08:00:00.000Z');
const read = (step, text) => readPersonnelAnswer(step, text, { now });
const value = (step, text) => {
  const result = read(step, text);
  assert.equal(result.ok, true, `${step}: «${text}» → ${JSON.stringify(result)}`);
  return result.value ?? result.amountToman ?? result.amountRial;
};

test('مرحله‌ها به ترتیب، فقط نام اجباری', () => {
  assert.deepEqual(PERSONNEL_STEPS.map((step) => step.id), ['name', 'nickname', 'nationalId', 'startDate', 'jobTitle', 'department', 'employmentType', 'baseWage', 'marital', 'children', 'insuranceNumber', 'mobile', 'iban']);
  assert.deepEqual(PERSONNEL_STEPS.filter((step) => step.required).map((step) => step.id), ['name']);
});

test('نام: محاوره، عنوان، تایپ بی‌دقت «اقای»؛ نام لازم است و «بعداً» ندارد', () => {
  for (const [text, name] of [
    ['اسمش آقای علی رضایی هست', 'علی رضایی'],
    ['اقای حسن  کریمی', 'حسن کریمی'],
    ['خانم مریم احمدی', 'مریم احمدی'],
    ['اسم و فامیل رضا محمدی', 'رضا محمدی'],
    ['نامش: سمیه کاظمی', 'سمیه کاظمی'],
  ]) assert.equal(value('name', text), name, text);
  assert.equal(read('name', 'بعداً').ok, false);
  assert.equal(read('name', 'ا').ok, false);
});

test('کد ملی: رقم فارسی، لاتین، گفتار عددی؛ رقم کنترل غلط و طول غلط رد می‌شوند', () => {
  for (const text of ['۰۰۸۴۵۷۵۹۴۸', '0084575948', '008-457594-8', 'کد ملیش صفر صفر هشتاد و چهار پنجاه و هفت پنجاه و نه چهل و هشت'])
    assert.equal(value('nationalId', text), '0084575948', text);
  assert.match(read('nationalId', '0084575949').message, /رقم کنترل/);
  assert.match(read('nationalId', '12345').message, /ده رقم/);
  assert.equal(validNationalId('1111111111'), false, 'تکرار یک رقم کد ملی نیست');
  assert.deepEqual(read('nationalId', 'بعدا'), { skip: true });
});

test('تاریخ شروع: شمسی نوشته، گفتاری، سال کوتاه گفته‌شده، «پارسال»، بی سال؛ آینده رد می‌شود', () => {
  const day = (text) => read('startDate', text).display;
  assert.equal(day('اول مهر ۱۴۰۲'), '1402/07/01');
  assert.equal(day('۱۴۰۲/۰۷/۰۱'), '1402/07/01');
  assert.equal(day('از پانزدهم فروردین هزار و چهارصد و سه'), '1403/01/15');
  assert.equal(day('بیستم اسفند چهارصد و دو'), '1402/12/20');
  assert.equal(day('دهم آبان پارسال'), '1404/08/10');
  assert.equal(day('دهم آبان'), '1405/08/10', 'امروز پذیرفته است');
  assert.equal(day('یازدهم آبان'), '1404/08/11', 'بی سال: آخرین باری که گذشته');
  assert.equal(read('startDate', '۱۴۰۶/۰۱/۰۱').ok, false);
  assert.equal(read('startDate', 'نمی‌دانم کی').ok, false);
});

test('سمت، بخش، نوع همکاری، تأهل: محاوره و نفی', () => {
  assert.equal(value('jobTitle', 'سمتش انباردار'), 'انباردار');
  // لقب: اختیاری، با پیش‌گفتار محاوره.
  assert.equal(value('nickname', 'لقبش اوستا'), 'اوستا');
  assert.equal(value('nickname', 'بهش میگن حاج آقا'), 'حاج آقا');
  assert.equal(value('nickname', 'صداش میکنن علی کوچیکه'), 'علی کوچیکه');
  assert.deepEqual(read('nickname', 'نداره'), { skip: true });
  assert.equal(value('department', 'کارگر تولیده'), 'production');
  assert.equal(value('department', 'حسابداره تو دفتر'), 'admin');
  assert.equal(value('department', 'ویزیتور'), 'sales');
  assert.match(read('department', 'نگهبان').message, /تولید/, 'بخش ناشناخته پرسیده می‌شود، حدس زده نمی‌شود');
  assert.equal(value('employmentType', 'تمام وقت'), 'full');
  assert.equal(value('employmentType', 'پاره‌وقت'), 'part');
  assert.equal(value('employmentType', 'ساعتی'), 'hourly');
  assert.equal(value('marital', 'ازدواج نکرده'), 'single', 'نفی پیش از «کرده»');
  assert.equal(value('marital', 'متاهله'), 'married');
  assert.equal(value('marital', 'متأهل'), 'married');
});

test('مزد: تومان و ریال گفتاری و رقمی؛ بی مبلغ رد می‌شود', () => {
  assert.equal(value('baseWage', 'حقوقش هجده میلیون تومن'), 18_000_000);
  assert.equal(value('baseWage', '۲۵ میلیون'), 25_000_000);
  assert.equal(read('baseWage', '۱۸۰ میلیون ریال').amountRial, 180_000_000);
  assert.equal(read('baseWage', 'هنوز معلوم نیست زیاده').ok, false);
});

test('فرزند: عدد، واژه، «ندارد» صفر است نه رد', () => {
  assert.equal(value('children', 'دو تا بچه داره'), 2);
  assert.equal(value('children', '۳'), 3);
  assert.equal(value('children', 'بچه نداره'), 0);
  assert.equal(value('children', 'ندارد'), 0);
});

test('موبایل، بیمه، شبا: پیش‌شماره‌ها، گفتار عددی، باقی‌ماندهٔ ۹۷', () => {
  assert.equal(value('mobile', 'صفر نهصد و دوازده سیصد و چهل و پنج شصت و هفت هشتاد و نه'), '09123456789');
  assert.equal(value('mobile', '+98 912 345 6789'), '09123456789');
  assert.equal(normalizeMobile('9123456789'), '09123456789');
  assert.equal(read('mobile', '0212345678').ok, false, 'تلفن ثابت موبایل نیست');
  assert.equal(value('insuranceNumber', '۱۲۳۴۵۶۷۸۹۰'), '1234567890');
  assert.equal(value('iban', 'IR820540102680020817909002'), 'IR820540102680020817909002');
  assert.equal(value('iban', 'ir 82 0540 1026 8002 0817 9090 02'), 'IR820540102680020817909002');
  assert.equal(validIban('IR820540102680020817909003'), false);
  assert.match(read('iban', 'IR8205401026').message, /۲۴ رقم/);
  assert.equal(spokenDigits('صفر صفر یک'), '001');
});

test('فرمان‌ها: «برگرد» و «بعداً» در هر مرحله', () => {
  assert.deepEqual(read('jobTitle', 'برگرد'), { back: true });
  assert.deepEqual(read('iban', 'فعلا نه'), { skip: true });
  assert.deepEqual(read('mobile', 'نداره'), { skip: true });
});

test('کامل‌بودن پرونده و کنترل پیش از ذخیره', () => {
  const partial = personnelCompleteness({ name: 'علی رضایی', nationalId: '0084575948', children: 0 });
  assert.equal(partial.percent, 23, '۳ از ۱۳');
  assert.ok(partial.missing.includes('شمارهٔ شبا'));
  const { errors } = validatePersonnel({ name: 'ع', nationalId: '0084575949', mobile: '123', iban: 'IR00', department: 'cleaning', baseWage: -5 });
  assert.deepEqual(errors.map((error) => error.field).sort(), ['baseWage', 'department', 'iban', 'mobile', 'name', 'nationalId']);
});

/**
 * گزارش مالک محصول (۱۰ آبان ۱۴۰۵): «امیرحسین ترابی را نمی‌گیرد، تا بگی امیرحسین خودش ثبتش
 * می‌کند»؛ «۱۲۷۳۹۲۵۳۵۱ را ۱۲۷ می‌نویسد و با ۳۹۲ قبلی را پاک می‌کند». Chrome پس از هر مکث
 * تکه‌ای را نهایی می‌کند؛ گفته‌های مرحله جمع می‌شوند و فقط فرمان صریح مرحله را می‌بندد.
 * همان مسیر صفحه: هر تکه با appendSpeechSegment روی گفته‌ها، بعد splitVoiceCommand.
 */
function speak(step, segments) {
  let buffer = '';
  for (const segment of segments) {
    buffer = appendSpeechSegment(buffer, segment);
    const { command, rest } = splitVoiceCommand(buffer);
    if (command) return { command, rest, result: rest ? read(step, rest) : null };
  }
  return { command: null, rest: buffer, result: null };
}

test('گفتار تکه‌تکه: مکث پاسخ را نمی‌بُرد؛ فقط «بعدی/تأیید» مرحله را می‌بندد', () => {
  for (const [step, segments, expected] of [
    ['name', ['امیرحسین', 'ترابی', 'بعدی'], 'امیرحسین ترابی'],
    ['name', ['اسمش امیرحسین', 'ترابی هست، تأیید'], 'امیرحسین ترابی'],
    ['nationalId', ['۱۲۷', '۳۹۲', '۵۳۵۱', 'تأیید'], '1273925351'],
    ['nationalId', ['صد و بیست و هفت', 'سیصد و نود و دو', 'پنجاه و سه', 'پنجاه و یک', 'بعدی'], '1273925351'],
    ['mobile', ['۰۹۱۲', '۳۴۵', '۶۷۸۹', 'درسته'], '09123456789'],
    ['startDate', ['اول مهر', 'هزار و چهارصد و دو', 'بعدی'], '2023-09-23T08:30:00.000Z'],
    ['iban', ['IR82', '0540 1026 8002', '0817 9090 02', 'اوکی'], 'IR820540102680020817909002'],
  ]) {
    const spoken = speak(step, segments);
    assert.equal(spoken.command, 'next', segments.join(' | '));
    assert.equal(spoken.result.value, expected, segments.join(' | '));
  }
  assert.equal(speak('baseWage', ['هجده', 'میلیون تومن', 'بعدی']).result.amountToman, 18_000_000);
  // بی فرمان چیزی بسته نمی‌شود، هرچقدر هم پاسخ معتبر به نظر برسد.
  assert.deepEqual(speak('name', ['امیرحسین']), { command: null, rest: 'امیرحسین', result: null });
  assert.equal(speak('nationalId', ['۱۲۷', '۳۹۲']).command, null);
  // فرمان‌ها.
  assert.equal(speak('jobTitle', ['انباردار', 'پاک کن']).command, 'clear');
  assert.equal(speak('jobTitle', ['برگرد']).command, 'back');
  assert.equal(speak('iban', ['بعداً']).command, 'skip');
  assert.equal(speak('name', ['امیرحسین ترابی', 'ذخیره']).rest, 'امیرحسین ترابی');
  // نیمهٔ کد ملی با «بعدی» پذیرفته نمی‌شود؛ مرحله باز می‌ماند.
  assert.equal(speak('nationalId', ['۱۲۷', '۳۹۲', 'بعدی']).result.ok, false);
});

process.env.DATABASE_PATH = tempDatabase('personnel');
process.env.ADMIN_USERNAME = 'personnel-owner';
process.env.ADMIN_PASSWORD = 'personnel-strong-password-4471';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('personnel-owner', 'personnel-strong-password-4471');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر پرسنل', profileType: 'business' });
const inBook = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

test('پرونده روی همان «شخص» با نقش پرسنل؛ کد ملی تکراری و نامعتبر ذخیره نمی‌شود', () => {
  inBook(() => {
    const ali = database.saveEmployee({ name: 'آقای علی رضایی', nationalId: '۰۰۸۴۵۷۵۹۴۸', startDate: '2023-09-23T08:30:00.000Z', department: 'production', employmentType: 'full', baseWage: 18_000_000, children: 2, mobile: '+989123456789' });
    assert.equal(ali.name, 'علی رضایی');
    assert.equal(ali.nationalId, '0084575948');
    assert.equal(ali.mobile, '09123456789');
    assert.equal(ali.active, true);
    const contact = database.listContacts().find((item) => item.id === ali.contactId);
    assert.deepEqual([contact.name, contact.role], ['علی رضایی', 'employee']);
    assert.throws(() => database.saveEmployee({ name: 'رضا کریمی', nationalId: '0084575948' }), /علی رضایی/);
    assert.throws(() => database.saveEmployee({ name: 'رضا کریمی', nationalId: '0084575949' }), (error) => error.code === 'PERSONNEL_INVALID' && error.details.errors[0].field === 'nationalId');
    // ویرایش همان پرونده، نه ردیف تازه.
    const edited = database.saveEmployee({ ...ali, id: ali.id, jobTitle: 'سرشیفت', nickname: 'اوستا' });
    assert.equal(edited.jobTitle, 'سرشیفت');
    assert.equal(edited.nickname, 'اوستا');
    assert.equal(database.listEmployees().length, 1);
  });
});

test('شریکی که کارمند هم هست نقش شریک را نگه می‌دارد؛ نام مشابه پرسیده می‌شود', () => {
  inBook(() => {
    const partner = database.saveContact({ name: 'مهدی صادقی', role: 'partner' });
    const ceo = database.saveEmployee({ name: 'مهدی صادقی', jobTitle: 'مدیرعامل' });
    assert.equal(ceo.contactId, partner.id);
    assert.equal(database.listContacts().find((item) => item.id === partner.id).role, 'partner');
    database.saveContact({ name: 'شرکت آرمان' });
    assert.throws(() => database.saveEmployee({ name: 'آرمان' }), (error) => error.code === 'COUNTERPARTY_SIMILAR');
    const separate = database.saveEmployee({ name: 'آرمان', counterpartyResolution: 'separate' });
    assert.equal(separate.name, 'آرمان');
  });
});

test('پایان همکاری پرونده را نگه می‌دارد؛ پیش از شروع کار پذیرفته نیست؛ بازگشت به کار', () => {
  inBook(() => {
    const ali = database.listEmployees().find((item) => item.name === 'علی رضایی');
    assert.throws(() => database.endEmployment(ali.id, { endDate: '2020-01-01T00:00:00.000Z' }), /پیش از شروع/);
    const ended = database.endEmployment(ali.id, { endDate: '2026-10-20T08:30:00.000Z' });
    assert.equal(ended.active, false);
    assert.ok(!database.listEmployees().some((item) => item.id === ali.id));
    assert.ok(database.listEmployees({ includeEnded: true }).some((item) => item.id === ali.id));
    assert.equal(database.resumeEmployment(ali.id).active, true);
  });
});
