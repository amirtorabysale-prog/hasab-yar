import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits, persianDate, unitLabel } from '../../lib/format.js';

// A shared sentence is not a reliable relationship between accounting documents.
export function matchingTransactionJournals(entries, transactionId) {
  return entries.filter((entry) => entry.sourceType === 'transaction' && entry.sourceId === transactionId);
}

export default function TransactionJourney({ item, canReadJournal, canReview, navigate }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null); setError('');
    if (!canReadJournal || !item.id) return;
    (async () => {
      const entries = [];
      let page = 1, pages = 1;
      do {
        const response = await api.journal({ search: item.id, page, limit: 100 });
        entries.push(...matchingTransactionJournals(response.items || [], item.id));
        pages = response.pages || 1;
        page += 1;
      } while (page <= pages && active);
      if (active) setResult(entries);
    })().catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [item.id, canReadJournal, retry]);
  const needsReview = Boolean(item.needsReview || item.reviewState === 'review' || item.journalDeferred);
  const status = !canReadJournal ? 'وضعیت سند در این دسترسی قابل مشاهده نیست' : error ? 'وضعیت سند دریافت نشد' : result === null ? 'در حال بررسی سند مرتبط…' : result.length ? 'سند مرتبط پیدا شد' : 'سند مرتبط با این شناسه پیدا نشد';
  return <div className="transaction-journey">
    <section className="journey-step"><span className="journey-number">۱</span><h3>چه گفتید؟</h3><blockquote className="whitespace-pre-wrap break-words text-sm leading-8">{item.rawText || 'متن اولیه برای این ثبت موجود نیست.'}</blockquote></section>
    <section className="journey-step"><span className="journey-number">۲</span><h3>چه چیزی در سیستم ذخیره شد؟</h3><dl className="journey-facts">
      {[[item.type === 'income' ? 'مبلغ دریافت' : 'مبلغ پرداخت', `${formatAmount(item.amount)} ${unitLabel()}`], ['دسته‌بندی فعلی', item.category || 'مشخص نشده'], ['حساب وجه', item.accountName || 'نام حساب در دسترس نیست'], ['طرف‌حساب', item.contactName || 'مشخص نشده'], ['تاریخ ثبت رویداد', item.occurredAt ? persianDate(item.occurredAt) : 'مشخص نشده']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl><p className="mt-3 text-xs leading-6 text-muted">این مبلغ مربوط به همین ردیف دریافت یا پرداخت است؛ ممکن است تمام مبلغ فروش یا خرید نباشد.</p></section>
    <section className="journey-step"><span className="journey-number">۳</span><h3>چه سندی ثبت شد؟</h3><p role="status" className="text-sm font-bold">{status}</p>
      {error && <div role="alert" className="mt-2 text-sm text-expense">{error}<button type="button" className="tap mr-3 underline" onClick={() => setRetry(retry + 1)}>تلاش دوباره</button></div>}
      {result?.map((entry) => <article key={entry.id} className="journey-document"><header><b>سند {toPersianDigits(entry.documentNumber ?? '—')}</b><span>{entry.entryKind === 'reversal' ? 'سند معکوس' : entry.entryKind === 'adjustment' ? 'سند اصلاحی' : 'سند مرتبط'} · {entry.approvalLabel}</span></header><p className="mb-3 text-xs leading-6 text-muted">{entry.memo}</p><div className="overflow-x-auto"><table className="w-full min-w-[360px] text-sm"><thead><tr><th>حساب</th><th>بدهکار</th><th>بستانکار</th></tr></thead><tbody>{entry.lines.map((line, index) => <tr key={index}><td>{line.name}{line.analyticName && <small className="block text-muted">{line.analyticName}</small>}</td><td className="numbers">{line.debit ? formatAmount(line.debit) : '—'}</td><td className="numbers">{line.credit ? formatAmount(line.credit) : '—'}</td></tr>)}</tbody></table></div><p className="mt-2 text-xs text-muted">مبالغ به {unitLabel()} · وضعیت تأیید سند، به‌تنهایی تأیید صحت ماهیت حسابداری نیست.</p></article>)}
    </section>
    <section className="journey-step"><span className="journey-number">۴</span><h3>قدم بعدی چیست؟</h3><p className="text-sm leading-7">{needsReview ? 'این ردیف علامت نیاز به بررسی دارد. برای دیدن پرسش‌ها و تکمیل اطلاعات، صف حسابدار را باز کنید.' : result?.length ? 'حساب‌ها و مبالغ سند بالا را بررسی کنید. این نمایش فقط سندهای مرتبط با همین ردیف را تأیید می‌کند؛ وضعیت کل فروش یا ماندهٔ طرف‌حساب باید در دفتر مالی بررسی شود.' : 'از اطلاعات فعلی نمی‌توان کامل‌شدن ثبت حسابداری را تأیید کرد. نبود سند در این نمایش به معنی رد یا حذف تراکنش نیست.'}</p><div className="mt-3 flex flex-wrap gap-2">{canReview && needsReview && <button type="button" className="tap rounded-lg bg-accent px-4 font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80" onClick={() => navigate('review')}>رفتن به صف حسابدار</button>}{canReadJournal && <button type="button" className="tap rounded-lg border border-line px-4 text-sm font-bold hover:bg-paper hover:text-ink" onClick={() => navigate('accounting')}>بازکردن دفتر اسناد</button>}</div></section>
  </div>;
}
