import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits } from '../../lib/format.js';

const KINDS = { normal: 'عادی', reversal: 'معکوس', adjustment: 'اصلاحی', opening: 'افتتاحیه' };

/**
 * سند حسابداریِ یک ردیف، از هر کارت حسابی که ردیف را نشان می‌دهد.
 *
 * کارت حساب گردش را نشان می‌دهد و سند می‌گوید آن گردش در برابر چه حسابی
 * نشست — «بستانکار جاری شریک» در برابر «بدهکار پرداختنی آریا». کاربر با یک کلیک
 * از ردیف به همان سند می‌رسد: شماره، وضعیت تأیید و همهٔ سطرهایش.
 *
 * `line.entryId` خالی یعنی ردیف هنوز سند قطعی ندارد (منتظر تأیید یا در صف
 * حسابدار)؛ همین گفته می‌شود، نه یک برگهٔ خالی.
 */
export function JournalEntrySheet({ line, close }) {
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState('');
  const entryId = line?.entryId || '';

  useEffect(() => {
    if (!entryId) return undefined;
    let active = true;
    setEntry(null); setError('');
    api.journal({ entryId }).then((result) => {
      if (!active) return;
      if (result.items?.[0]) setEntry(result.items[0]);
      else setError('این سند دیگر در دفتر نیست؛ احتمالاً معکوس یا جایگزین شده است.');
    }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [entryId]);

  const totals = (entry?.lines || []).reduce((sum, row) => ({ debit: sum.debit + row.debit, credit: sum.credit + row.credit }), { debit: 0, credit: 0 });

  return <div className="fixed inset-0 z-[80] flex items-end justify-center bg-scrim/40 backdrop-blur-[2px] sm:items-center" onClick={close}>
    <section role="dialog" aria-modal="true" aria-label="سند حسابداری" onClick={(event) => event.stopPropagation()}
      className="sheet-in max-h-[90vh] w-full max-w-[680px] overflow-y-auto rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl sm:rounded-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="rounded-full bg-accent/10 px-2 py-1 text-xs font-extrabold text-accent">سند حسابداری</span>
          <h2 className="mt-2 text-lg font-extrabold">
            {entry ? `سند شماره ${toPersianDigits(entry.documentNumber ?? '—')} · سال ${toPersianDigits(entry.fiscalYear ?? '—')}` : (line?.title || 'سند این ردیف')}
          </h2>
          {entry && <p className="mt-1 text-[12px] text-muted">
            {persianDate(entry.occurredAt)} · {KINDS[entry.entryKind] || entry.entryKind} · <span className="font-bold">{entry.approvalLabel}</span>
          </p>}
        </div>
        <button onClick={close} aria-label="بستن" className="tap grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line hover:bg-paper hover:text-ink"><X size={17} /></button>
      </div>

      {!entryId && <p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-[12px] leading-6 text-accent">
        این ردیف هنوز سند قطعی در دفتر کل ندارد؛ یا منتظر تأیید است یا در صف حسابدار. وقتی تأیید شود، از همین‌جا سندش باز می‌شود.
      </p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-expense px-3 py-3 text-[12px] text-expense">{error}</p>}
      {entryId && !entry && !error && <p role="status" className="mt-6 text-center text-sm text-muted">در حال خواندن سند…</p>}

      {entry && <>
        {entry.memo && <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-6">{entry.memo}</p>}
        <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead className="bg-paper text-xs text-muted"><tr>
              {['ردیف', 'حساب', 'شرح', 'بدهکار', 'بستانکار'].map((label) => <th key={label} className="p-2 text-right font-bold">{label}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-line">
              {entry.lines.map((row, index) => <tr key={`${row.accountId}-${index}`}>
                <td className="numbers p-2 text-muted">{toPersianDigits(index + 1)}</td>
                <td className="p-2"><b className="block">{row.name}</b><span className="numbers text-xs text-muted">{row.chartCode ? `${toPersianDigits(row.chartCode)} · ${row.chartName}` : toPersianDigits(row.code || '')}</span></td>
                <td className="p-2 text-[12px] text-muted">{row.description || row.analyticName || '—'}</td>
                <td className="numbers p-2 font-bold text-income">{row.debit ? formatAmount(row.debit) : '—'}</td>
                <td className="numbers p-2 font-bold text-expense">{row.credit ? formatAmount(row.credit) : '—'}</td>
              </tr>)}
            </tbody>
            <tfoot className="bg-paper text-[12px]"><tr>
              <td colSpan={3} className="p-2 font-bold">جمع</td>
              <td className="numbers p-2 font-extrabold">{formatAmount(totals.debit)}</td>
              <td className="numbers p-2 font-extrabold">{formatAmount(totals.credit)}</td>
            </tr></tfoot>
          </table>
        </div>
        <p className={`mt-2 text-xs ${totals.debit === totals.credit ? 'text-income' : 'text-expense'}`}>
          {totals.debit === totals.credit ? 'بدهکار و بستانکار متوازن است.' : `اختلاف سند: ${formatAmount(Math.abs(totals.debit - totals.credit))}`}
        </p>
        {entry.returnReason && <p className="mt-2 text-[12px] text-expense">دلیل برگشت: {entry.returnReason}</p>}
        <p className="mt-2 text-xs text-muted">برای تأیید یا اصلاح، همین شماره را در «حسابداری و اسناد ← اسناد ثبت‌شده» جست‌وجو کن.</p>
      </>}
    </section>
  </div>;
}
