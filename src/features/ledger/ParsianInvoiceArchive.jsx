// بایگانی فاکتورهای بکاپ پارسیان، زیر برگهٔ «فاکتور».
//
// فقط‌خواندنی است و در «مطالبات باز» شمرده نمی‌شود: پارسیان نمی‌گوید کدام دریافت
// کدام فاکتور را بست، و طلب واقعی همان ماندهٔ طرف حساب در دفتر کل است. هر فاکتور
// شمارهٔ سند پارسیانِ خودش را دارد که در دفتر اسناد هم هست.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

const FILTERS = [['', 'همه'], ['sales', 'فروش'], ['purchase', 'خرید']];

export function ParsianInvoiceArchive({ notify }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('');
  useEffect(() => {
    let alive = true;
    api.parsianInvoiceArchive(kind).then((response) => { if (alive) setData(response); }).catch((error) => { if (alive) notify?.(error.message); });
    return () => { alive = false; };
    // notify هر رندر والد تازه است؛ فقط تغییر نوع، دوباره می‌خواند.

  }, [kind]);
  // دفتری که بکاپ پارسیان ندارد این بخش را نمی‌بیند.
  if (!data || (!data.items.length && !kind)) return null;
  const total = (name) => data.totals.find((item) => item.kind === name) || { count: 0, gross: 0 };
  return <section aria-labelledby="parsian-archive-title" className="rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 id="parsian-archive-title" className="font-extrabold">فاکتورهای بکاپ پارسیان</h2>
        <p className="mt-1 text-xs leading-5 text-muted">بایگانی فقط‌خواندنی؛ مبلغ هر کدام با سند پارسیانِ خودش در دفتر کل نشسته و طلب و بدهی از ماندهٔ طرف حساب خوانده می‌شود، نه از این فهرست.</p>
      </div>
      <div className="flex gap-1" role="group" aria-label="نوع فاکتور">
        {FILTERS.map(([value, label]) => <button key={value || 'all'} type="button" onClick={() => setKind(value)} aria-pressed={kind === value}
          className={`tap rounded-lg border px-3 text-xs font-bold ${kind === value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-paper'}`}>{label}</button>)}
      </div>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2">
      {[['sales', 'فروش'], ['purchase', 'خرید']].map(([name, label]) => <div key={name} className="rounded-lg border border-line bg-paper p-3">
        <p className="text-xs text-muted">{label} — {toPersianDigits(total(name).count)} فاکتور</p>
        <b className="numbers mt-1 block">{formatAmount(total(name).gross)} {unitLabel()}</b>
        <p className="text-[11px] text-muted">با مالیات، از ردیف طرف حساب در سند</p>
      </div>)}
    </div>
    <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-paper">
      {data.items.map((item) => <li key={item.id}>
        <details className="group px-3 py-2">
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0">
              <b>{item.kindLabel} {toPersianDigits(item.number)}</b>
              <span className="mr-2 text-muted">{item.counterpartyName || 'بی‌طرف حساب'}</span>
            </span>
            <span className="flex items-center gap-3 text-xs text-muted">
              <span className="numbers">{toPersianDigits(item.jalaliDate)}</span>
              {item.sanad > 0 && <span>سند {toPersianDigits(item.sanad)}</span>}
              <b className="numbers text-[13px] text-ink">{item.gross != null ? formatAmount(item.gross) : item.subtotal != null ? formatAmount(item.subtotal) : '—'}</b>
            </span>
          </summary>
          <div className="mt-2 overflow-x-auto overflow-y-hidden">
            <table className="w-full min-w-[420px] text-right text-xs">
              <thead className="text-muted"><tr><th className="p-1 font-bold">کالا</th><th className="p-1 font-bold">تعداد</th><th className="p-1 font-bold">قیمت واحد</th><th className="p-1 font-bold">جمع</th></tr></thead>
              <tbody>{item.lines.map((line, index) => <tr key={index} className="border-t border-line">
                <td className="p-1">{line.title}</td>
                <td className="numbers p-1">{toPersianDigits(line.quantity)} {line.unit}</td>
                <td className="numbers p-1">{line.unitPrice != null ? formatAmount(line.unitPrice) : '—'}</td>
                <td className="numbers p-1">{line.total != null ? formatAmount(line.total) : '—'}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted">
              جمع ردیف‌ها {item.subtotal != null ? `${formatAmount(item.subtotal)} ${unitLabel()}` : 'نامشخص'}
              {item.gross != null && item.subtotal != null && item.gross !== item.subtotal ? ` — با مالیات و عوارض ${formatAmount(item.gross)} ${unitLabel()}` : ''}
              {!item.amountsExact ? ' — بخشی از مبلغ‌ها در واحد این دفتر دقیق درنمی‌آمد؛ سند پارسیان مرجع است.' : ''}
          </p>
        </details>
      </li>)}
      {!data.items.length && <li className="px-3 py-3 text-xs text-muted">فاکتوری از این نوع در بکاپ نیست.</li>}
    </ul>
  </section>;
}
