import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoice, describePlan } from './helpers/voicePipeline.js';
import { hasCompositeAmounts } from '../shared/parser.js';
import { detectCaptureTransfer } from '../shared/bankSpeech.js';

/**
 * آزمون خانوادگیِ گفتار: هر مفهوم با ده‌ها شکل گفتنش.
 *
 * اصلاح‌های قبلی هر بار همان یک جمله‌ای را درست می‌کردند که خطا داده بود؛
 * «قرض گرفتیم» درست می‌شد و «قرض کردیم» نه، «پس دادیم» درست می‌شد و «عودت
 * دادیم» نه. اولین اجرای این فایل ۸۸ شکل از ۷۸۰ را غلط نشان داد — همه از
 * خانواده‌هایی که «درست شده» بودند.
 *
 * هر خانواده ضرب دکارتیِ صیغه‌ها، مترادف‌ها، بانک‌ها و ترتیب‌هاست و از همان
 * مسیر `routeIntent` می‌گذرد (چندمبلغی ← انتقال ← تسویه ← کارت‌ها ← پارسر و
 * موتور). اصلاح تازه باید خانواده‌اش را اینجا اضافه کند، نه فقط یک جمله.
 *
 * محدودیت عمدی: «ملی» بی «بانک» یا «حساب» بانک شناخته نمی‌شود («کد ملی»،
 * «کارت ملی»)؛ این خانواده‌ها شکل «بانک ملی» را می‌آزمایند.
 */
const accounts = [{ id: 'cash', kind: 'cash' }, { id: 'm', kind: 'bank', bankId: 'mellat' }, { id: 't', kind: 'bank', bankId: 'tejarat' }, { id: 's', kind: 'bank', bankId: 'saderat' }, { id: 'n', kind: 'bank', bankId: 'melli' }];
function route(text) {
  if (hasCompositeAmounts(text)) return { path: 'composite-review', items: [{ outcome: 'accountant' }] };
  const transfer = detectCaptureTransfer(text, { accounts });
  if (transfer) return { path: 'transfer', items: [{ outcome: 'post', amount: transfer.amount }] };
  return runVoice(text, { today: '2026-10-10T08:00:00.000Z' });
}
const cross = (...lists) => lists.reduce((acc, list) => acc.flatMap((a) => list.map((b) => [...a, b])), [[]]);
const lines = (item) => describePlan(item.plan);
const roles = (item, side) => (item.plan?.lines || []).filter((l) => (side === 'Dr' ? l.debit : l.credit)).map((l) => l.role);
const CASHLIKE = /^(cash|bank|operational|cash-account|bank-account)/;

const families = {
  'وام/قرض دریافتی از شخص': {
    texts: cross(['۵۰ میلیون', 'پنجاه میلیون'], ['از آقای نوری', 'از خانم رضایی', 'از برادرم', 'از دوستم علی'],
      ['قرض گرفتیم', 'قرض گرفتم', 'قرض کردیم', 'وام گرفتیم', 'قرض الحسنه گرفتیم', 'دستی گرفتیم'],
      ['', '، ریخت به ملت', ' و نقد داد', '، کارت به کارت کرد به حساب تجارت']).map((p) => p.join(' ').replace(/\s+،/g, '،')),
    ok: (r) => r.items.every((i) => i.outcome !== 'post' || (roles(i, 'Dr').some((x) => CASHLIKE.test(x)) && !roles(i, 'Cr').some((x) => /income|sales|revenue/.test(x)))) && r.path !== 'obligation',
  },
  'برگشت از خرید': {
    texts: cross(['۵ میلیون از', 'پنج میلیون از'], ['مواد اولیه‌ای', 'جنسی', 'کالایی', 'پارچه‌ای'], ['که از آقای کاظمی خریده بودیم', 'که از تامین‌کننده گرفته بودیم'],
      ['رو پس دادیم', 'رو برگردوندیم', 'رو مرجوع کردیم', 'رو عودت دادیم', 'رو پس فرستادیم']).map((p) => p.join(' ')),
    ok: (r) => r.items.every((i) => i.outcome !== 'post'),
  },
  'انتقال بین حساب‌های خودمان': {
    texts: [
      ...cross(['۵۰ میلیون'], ['از ملت به تجارت', 'از حساب ملت به حساب تجارت', 'از بانک ملت به بانک صادرات', 'از تجارت به بانک ملی', 'از صندوق به ملت', 'از ملت به صندوق'],
        ['منتقل کردیم', 'انتقال دادیم', 'کارت به کارت کردیم', 'پایا زدیم', 'ساتنا کردیم', 'زدیم', 'ریختیم', 'واریز کردیم', 'جابجا کردیم']).map((p) => p.join(' ')),
      ...['۳ میلیون از عابربانک ملت برداشت کردم گذاشتم تو صندوق', '۳ میلیون از خودپرداز تجارت گرفتم آوردم صندوق', 'پول صندوق رو ۲۰ میلیون بردیم بانک ملت واریز کردیم', '۲۰ میلیون از صندوق به حساب ملت واریز شد'],
    ],
    ok: (r) => r.path === 'transfer',
  },
  'پرداخت با دو بانک، نه انتقال': {
    texts: ['حقوق رو ۱۸ میلیون از ملت به حسابش تو تجارت واریز کردیم', 'قبض برق ۲ میلیون از ملت زدیم', 'اجاره ۲۰ میلیون از ملت به حساب صاحبخونه تو تجارت ریختیم', '۱۰ میلیون از ملت به آقای رضایی کارت به کارت کردیم', 'بابت خرید مواد ۱۵ میلیون از ملت به تجارت زدیم'],
    ok: (r) => r.path !== 'transfer',
  },
  'پولی که طرف مقابل آورد یا پس داد': {
    texts: cross(['خانم توکلی', 'آقای صالحی', 'مشتری'], ['۹ میلیون'], ['از بدهیش', 'بابت طلبمون', ''],
      ['نقد آورد', 'رو نقد آورد', 'پولشو آورد', 'آورد داد', 'نقد داد', 'داد بهمون', 'پرداخت کرد', 'تسویه کرد', 'کارت به کارت کرد']).map((p) => p.join(' ').replace(/\s+/g, ' ')),
    ok: (r) => r.items.every((i) => !(i.outcome === 'post' && roles(i, 'Cr').some((x) => CASHLIKE.test(x)))) && r.items.every((i) => i.kind !== 'cash-expense'),
  },
  'فروش وسیلهٔ کارکرده': {
    texts: cross(['پرینتر', 'لپ تاپ', 'یخچال', 'وانت', 'میز و صندلی', 'کامپیوتر', 'کولر', 'دستگاه کپی'], ['قدیمی دفتر', 'دست دوم خودمون', 'کهنهٔ مغازه', 'قبلی شرکت'], ['رو ۳ میلیون'], ['فروختیم', 'فروختم', 'نقد فروختیم', 'دادیم رفت ۳ میلیون گرفتیم']).map((p) => p.join(' ')),
    ok: (r) => r.items.every((i) => !(i.outcome === 'post' && roles(i, 'Cr').some((x) => /sales|revenue|income/.test(x)))),
  },
  'تخفیف با چند مبلغ': {
    texts: cross(['به شرکت نوین ۱۵ میلیون جنس فروختیم'], ['، ۱ میلیون تخفیف دادیم', '، یک میلیون تخفیف خوردن', '، ۱ میلیون کم کردیم', '، یه میلیون ازش کم کردیم'], [' و ۱۴ میلیون رو کارت به کارت به ملت زد', ' و ۱۴ میلیون واریز کرد']).map((p) => p.join('')),
    ok: (r) => r.items.every((i) => i.outcome !== 'post' || i.amount !== 15_000_000),
  },
  'اجارهٔ ماه نام‌برده': {
    texts: cross(['اجاره', 'اجارهٔ', 'اجاره‌ی', 'اجاره بهای', 'کرایه مغازه', 'کرایه دفتر', 'شارژ ساختمون'], ['مهر', 'ماه مهر', 'مهر ماه', 'شهریور'], ['رو ۲۰ میلیون', '۲۰ میلیون'], ['دادیم', 'پرداخت کردیم', 'ریختیم']).map((p) => p.join(' ')),
    ok: (r) => r.items.every((i) => !(i.outcome === 'ask' && /servicePeriod/.test(i.fact || ''))),
  },
  'واریز اول‌شخص = پرداخت': {
    texts: cross(['حقوق خانم احمدی رو', 'اجاره رو', 'پول آقای کاظمی رو', 'قسط رو'], ['۱۸ میلیون'], ['از ملت واریز کردیم', 'واریز کردم', 'به حسابش واریز کردیم']).map((p) => p.join(' ')),
    ok: (r) => r.items.every((i) => i.kind !== 'cash-income'),
  },
  'مبلغ کوچکِ تومنی': {
    texts: cross(['بنزین', 'نون', 'کرایه تاکسی', 'پارکینگ'], ['۸۰۰ تومن', '۵۰۰ تومن', 'هشتصد تومن', '۲۵۰ تومان'], ['دادیم', 'زدیم', 'شد']).map((p) => p.join(' ')),
    ok: (r) => r.items.every((i) => i.outcome !== 'post' || i.amount >= 1000),
  },
};

for (const [name, family] of Object.entries(families)) {
  test(`خانوادهٔ گفتار: ${name}`, () => {
    const failures = [];
    for (const text of family.texts) {
      const r = route(text);
      if (!family.ok(r)) failures.push(`${text}  →  ${r.path}: ${r.items.map((i) => `${i.outcome}${i.fact ? `(${i.fact})` : ''} ${i.kind || ''} ${lines(i)}`).join(' | ')}`);
    }
    assert.deepEqual(failures, [], `${failures.length} شکل از ${family.texts.length} غلط:\n${failures.slice(0, 15).join('\n')}`);
  });
}
