// چک‌های ضمانتِ بکاپ پارسیان، زیر برگهٔ «چک‌ها».
//
// فقط‌خواندنی: چک ضمانت پرداخت نیست، سند ندارد و در هیچ مانده‌ای شمرده نمی‌شود
// (server/parsianSideRecords.js). این‌جا هست تا سررسید و برگرداندنش فراموش نشود.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

const DIRECTION_LABELS = { receivable: 'دریافتی (ضمانت به ما)', payable: 'پرداختی (ضمانت از ما)', unknown: 'نوع نامعلوم' };

export function GuaranteeCheques() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.guaranteeCheques().then(({ items: list }) => setItems(list || [])).catch(() => setItems([])); }, []);
  // دفتری که بکاپ پارسیان یا چک ضمانت ندارد این بخش را نمی‌بیند.
  if (!items?.length) return null;
  const now = Date.now();
  return <section aria-labelledby="guarantee-cheques-title" className="mt-6 rounded-xl border border-line bg-surface p-4">
    <h2 id="guarantee-cheques-title" className="font-extrabold">چک‌های ضمانت</h2>
    <p className="mt-1 text-xs leading-6 text-muted">از بکاپ پارسیان. چک ضمانت پرداخت نیست: سند ندارد و در مانده‌ها شمرده نمی‌شود؛ برای یادآوری سررسید و برگرداندن است.</p>
    <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-paper">
      {items.map((item) => {
        const passed = item.dueAt && new Date(item.dueAt).getTime() < now;
        return <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-[13px]">
          <span className="min-w-0">
            <b>{DIRECTION_LABELS[item.direction]}</b>
            <span className="mr-2 text-muted">{item.party || 'طرف حساب نامعلوم'}</span>
            <span className="block text-xs text-muted">
              {item.serial ? `شمارهٔ ${toPersianDigits(item.serial)}` : 'بی‌شماره'}
              {item.bank ? ` · ${item.bank}` : ''}{item.branch ? ` · شعبهٔ ${item.branch}` : ''}
              {item.comment ? ` · ${item.comment}` : ''}
            </span>
          </span>
          <span className="text-left">
            <b className="numbers block">{item.amount != null ? `${formatAmount(item.amount)} ${unitLabel()}` : 'مبلغ نامشخص'}</b>
            <span className={`numbers text-xs ${passed ? 'font-bold text-expense' : 'text-muted'}`}>
              سررسید {item.dueJalali ? toPersianDigits(item.dueJalali) : 'ندارد'}{passed ? ' · گذشته' : ''}
            </span>
          </span>
        </li>;
      })}
    </ul>
  </section>;
}
