import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoice } from './helpers/voicePipeline.js';

// گفته‌های کامل بازیابی‌شده از صف واقعی آزمون ۴۰ موردی. چند ردیف صف، تکه‌های
// یک گفته‌اند و هفت ورودی ناموفق در صف نیستند؛ این مجموعه را «۴۰/۴۰» نمی‌نامیم.
const unsafeCash = [
  'امروز 3 میلیون تومان کسری موجودی انبار شناسایی شد بدون پرداخت وجه',
  'امروز 15 میلیون تومان کالا نسیه از شرکت اپسیلون خریدیم و پولی ندادیم',
  'امروز 20 میلیون تومان کالا نسیه به شرکت دلتا فروختیم و پولی نگرفتیم',
  'هزینه برق شهریور 3 میلیون تومان است و هنوز پرداخت نکردم',
];

for (const utterance of unsafeCash) {
  test(`بدون جابه‌جایی پول هیچ ردیف نقدی نسازد: ${utterance}`, () => {
    const result = runVoice(utterance);
    assert.equal(result.path, 'queued');
    assert.ok(result.items.length > 0);
    assert.ok(result.items.every((item) => item.outcome === 'accountant' && item.noCashRow));
  });
}

const ambiguous = [
  'امروز 5 میلیون تومان ذخیره مطالبات مشکوک الوصول شناسایی کردیم',
  'امروز 10 میلیون تومان برای ارتقای اساسی دستگاه و افزایش عمر آن پرداخت کردم',
  'امروز 45 میلیون تومان برای خرید لپ تاپ اداری پرداخت کردم',
  'امروز 25 میلیون تومان پیش دریافت از مشتری برای کالایی که هنوز تحویل نداده ایم گرفتم',
  'امروز 30 میلیون تومان از صندوق به بانک انتقال دادم',
  'امروز مالک 60 میلیون تومان سرمایه به صندوق واریز کرد',
  'امروز 100 میلیون تومان وام بانکی به صندوق واریز شد',
];

for (const utterance of ambiguous) {
  test(`ثبت حدسی به دفتر راه نیابد: ${utterance}`, () => {
    const result = runVoice(utterance);
    assert.ok(result.items.length > 0);
    assert.ok(result.items.every((item) => item.outcome !== 'post'));
  });
}
