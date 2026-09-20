import { ReceiptText, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

export function TaxPage({ access, notify }) {
  const [days, setDays] = useState(90);
  const [report, setReport] = useState({ summary: {}, rows: [], rates: [], disclaimer: '' });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: '', rate: '', treatment: 'taxable', active: true, isDefault: false });
  const canManage = ['owner', 'manager'].includes(access.workspace?.role);
  const load = useCallback(async () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    try { setReport(await api.taxReport(from.toISOString(), to.toISOString())); }
    catch (error) { notify(error.message); }
  }, [days, notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const save = async (event) => {
    event.preventDefault();
    if (!canManage) return notify('برای تغییر نرخ‌ها نقش مدیر یا مالک لازم است.');
    setBusy(true);
    try { await api.saveTaxRate({ ...draft, rate: draft.treatment === 'taxable' ? Number(draft.rate) : 0 }); setDraft({ name: '', rate: '', treatment: 'taxable', active: true, isDefault: false }); await load(); notify('نرخ مالیاتی ذخیره شد؛ فاکتورهای قبلی بدون تغییر می‌مانند.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const toggle = async (rate) => {
    if (!canManage || rate.id === 'tax-none') return;
    setBusy(true);
    try { await api.saveTaxRate({ ...rate, active: !rate.active }); await load(); notify(rate.active ? 'نرخ غیرفعال شد.' : 'نرخ دوباره فعال شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  /**
   * تسویهٔ دوره — از ماندهٔ دفتر، نه از گزارش بالا.
   *
   * گزارش می‌گوید این بازه چه شد؛ مانده می‌گوید چقدر از آن هنوز تسویه نشده.
   * این دو یکی نیستند و قاطی‌شدنشان یعنی یک دوره دو بار پرداخت می‌شود.
   */
  const settleVat = async () => {
    const payable = Math.max(0, (ledger.outputTax || 0) - (ledger.inputTax || 0));
    const message = payable > 0
      ? `مالیات فروشِ تسویه‌نشده ${formatAmount(ledger.outputTax || 0)} تومان است و اعتبار خرید ${formatAmount(ledger.inputTax || 0)} تومان. سند تسویه ثبت شود و ${formatAmount(payable)} تومان پرداخت شود؟`
      : `مالیات فروشِ تسویه‌نشده ${formatAmount(ledger.outputTax || 0)} تومان با اعتبار خرید خنثی می‌شود و پرداختی ندارد. سند تسویه ثبت شود؟`;
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      const result = await api.settleVatPeriod({});
      await load();
      notify(result.paid > 0
        ? `تسویه ثبت شد؛ ${formatAmount(result.paid)} تومان پرداخت شد.`
        : `تسویه ثبت شد؛ ${formatAmount(result.carriedForward)} تومان اعتبار به دورهٔ بعد منتقل شد.`);
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const summary = report.summary || {};
  const ledger = report.ledger || {};
  const treatmentLabels = { taxable: 'مشمول', zero: 'نرخ صفر', exempt: 'معاف' };
  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <div><p className="text-[13px] font-bold text-accent">کنترل مدیریتی مالیات</p><h1 className="mt-1 text-xl font-extrabold">مالیات و ارزش افزوده</h1><p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">نرخ‌ها را مطابق وضعیت کسب‌وکارت تعریف کن. حساب‌یار مبلغ را شفاف محاسبه و در دفتر کل تفکیک می‌کند، اما به سامانه مودیان ارسال نمی‌کند.</p></div>
    <TaxAssistantPanel access={access} notify={notify} />
    {/* ارزش افزوده هزینهٔ شرکت نیست؛ پول سازمان است که شرکت جمعش کرده. تا
        تسویه نشود، دو حساب ارزش افزوده تا ابد بزرگ می‌شوند. */}
    <section className="mt-4 rounded-[10px] border border-accent/40 bg-warn-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-extrabold text-accent">ماندهٔ تسویه‌نشدهٔ ارزش افزوده</h2>
          <p className="mt-1 text-[12px] leading-6 text-muted">
            این عدد از دفتر می‌آید، نه از بازهٔ گزارش پایین: مالیات فروش <b className="numbers text-ink">{formatAmount(ledger.outputTax || 0)}</b> تومان
            و اعتبار خرید <b className="numbers text-ink">{formatAmount(ledger.inputTax || 0)}</b> تومان.
            تسویه اعتبار را خنثی می‌کند و فقط خالص را می‌پردازد؛ اعتبار اضافی به دورهٔ بعد منتقل می‌شود.
          </p>
        </div>
        {canManage && (ledger.outputTax || 0) > 0 && <button disabled={busy} onClick={settleVat}
          className="tap shrink-0 rounded-lg bg-accent px-4 font-bold text-white disabled:opacity-45">ثبت سند تسویه</button>}
      </div>
    </section>
    <div className="mt-4 grid grid-cols-3 rounded-lg border border-line bg-surface p-1">{[[30, '۳۰ روز'], [90, '۹۰ روز'], [365, 'یک سال']].map(([value, label]) => <button key={value} onClick={() => setDays(value)} className={`tap rounded-md text-sm font-bold ${days === value ? 'bg-ink text-white' : 'text-muted'}`}>{label}</button>)}</div>
    <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مالیات فروش</p><b className="numbers mt-2 block text-lg text-expense">{formatAmount(summary.outputTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">اعتبار خرید</p><b className="numbers mt-2 block text-lg text-income">{formatAmount(summary.inputTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">خالص برآوردی</p><b className={`numbers mt-2 block text-lg ${(summary.netTax || 0) > 0 ? 'text-expense' : 'text-income'}`}>{formatAmount(summary.netTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مالیات دستی قدیمی</p><b className="numbers mt-2 block text-lg">{formatAmount(summary.manualTax || 0)}</b><span className="text-[10px] text-muted">نیازمند بازبینی</span></div></div>
    <section className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">تفکیک فروش</h2><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">مشمول</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.taxableSales || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">نرخ صفر</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.zeroSales || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">معاف</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.exemptSales || 0)}</b></div></div><p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[11px] leading-6 text-muted">«نرخ صفر» و «معاف» از نظر گزارش یکسان نیستند؛ انتخاب نوع صحیح بر عهده کسب‌وکار و حسابدار است.</p></section>
    {canManage && <form onSubmit={save} className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">تعریف نرخ</h2><p className="mt-1 text-xs leading-6 text-muted">هیچ نرخ قانونی پیش‌فرضی داخل برنامه قرار نگرفته؛ نرخ معتبر خودت را وارد کن.</p><div className="mt-3 grid gap-2 sm:grid-cols-3"><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="مثلاً نرخ عمومی" className="tap rounded-lg border border-line px-3" /><select value={draft.treatment} onChange={(event) => setDraft({ ...draft, treatment: event.target.value, rate: event.target.value === 'taxable' ? draft.rate : '0' })} className="tap rounded-lg border border-line bg-surface px-3"><option value="taxable">مشمول</option><option value="zero">نرخ صفر</option><option value="exempt">معاف</option></select><label className="flex items-center rounded-lg border border-line px-3 text-xs text-muted">درصد<input required={draft.treatment === 'taxable'} disabled={draft.treatment !== 'taxable'} inputMode="decimal" value={draft.rate} onChange={(event) => setDraft({ ...draft, rate: event.target.value.replace(/[^0-9.]/g, '') })} className="tap numbers min-w-0 flex-1 bg-transparent text-left text-ink outline-none disabled:opacity-40" /></label></div><label className="mt-3 flex min-h-12 items-center gap-2 text-xs font-bold"><input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} />پیش‌فرض فاکتورهای تازه</label><button disabled={busy} className="tap mt-2 w-full rounded-lg bg-accent font-bold text-white disabled:opacity-40">ذخیره نرخ</button></form>}
    <section className="mt-6"><div className="flex items-center justify-between"><h2 className="font-extrabold">نرخ‌های تعریف‌شده</h2><span className="text-xs text-muted">{toPersianDigits(report.rates?.length || 0)} نرخ</span></div><div className="mt-2 divide-y divide-line border-y border-line">{report.rates?.map((rate) => <article key={rate.id} className="flex min-h-[68px] items-center gap-3 py-3"><div className={`h-2.5 w-2.5 rounded-full ${rate.active ? 'bg-income' : 'bg-muted'}`} /><div className="min-w-0 flex-1"><p className="font-bold">{rate.name}{rate.isDefault ? <span className="mr-2 rounded border border-accent px-1.5 py-0.5 text-[10px] text-accent">پیش‌فرض</span> : null}</p><p className="mt-1 text-xs text-muted">{treatmentLabels[rate.treatment]} · {toPersianDigits(rate.rate)}٪ · {rate.active ? 'فعال' : 'غیرفعال'}</p></div>{canManage && rate.id !== 'tax-none' && <button disabled={busy} onClick={() => toggle(rate)} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted">{rate.active ? 'غیرفعال' : 'فعال'}</button>}</article>)}</div></section>
    <section className="mt-6"><div className="flex items-center justify-between"><h2 className="font-extrabold">اسناد این بازه</h2><span className="text-xs text-muted">{toPersianDigits(report.rows?.length || 0)} سند</span></div><div className="mt-2 divide-y divide-line border-y border-line">{report.rows?.slice(0, 50).map((invoice) => <article key={invoice.id} className="flex min-h-[72px] items-center gap-3 py-3"><ReceiptText className={invoice.documentType === 'sales' ? 'text-income' : 'text-expense'} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{invoice.number} · {invoice.customerName}</p><p className="mt-1 text-xs text-muted">{invoice.documentType === 'sales' ? 'فروش' : 'خرید'} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(invoice.issuedAt))}{invoice.manualTax ? ' · مالیات دستی' : ''}</p></div><div className="text-left"><b className="numbers block text-sm">{formatAmount(invoice.total)}</b><span className="numbers mt-1 block text-[10px] text-muted">مالیات {formatAmount(invoice.tax)}</span></div></article>)}</div></section>
    <p className="mt-5 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-xs leading-6 text-muted">{report.disclaimer || 'این گزارش مدیریتی است و جایگزین اظهارنامه یا صورتحساب رسمی نیست.'}</p>
  </main>;
}

function TaxAssistantPanel({ access, notify }) {
  const canManage = ['owner', 'manager'].includes(access.workspace?.role);
  const [question, setQuestion] = useState('');
  const [questionKind, setQuestionKind] = useState('general');
  const [items, setItems] = useState([]);
  const [sources, setSources] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState({ title: '', issuer: '', officialUrl: '', summary: '', keywords: '', versionLabel: '', effectiveFrom: '', effectiveTo: '', verifiedAt: '' });
  const load = useCallback(async () => {
    try {
      const [questionResult, sourceResult] = await Promise.all([api.taxAssistantQuestions(), api.taxAssistantSources()]);
      setItems(questionResult.items || []); setSources(sourceResult.items || []);
    } catch (error) { notify(error.message); }
  }, [notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const ask = async (event) => {
    event.preventDefault(); if (!question.trim()) return;
    setBusy(true);
    try {
      const result = await api.askTaxAssistant({ question, questionKind });
      setQuestion(''); setItems((current) => [result.item, ...current]);
      notify(result.item.status === 'answered' ? 'پاسخ منبع‌دار آماده شد.' : 'سؤال برای بررسی متخصص ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const saveSource = async (event) => {
    event.preventDefault(); setBusy(true);
    try {
      await api.saveTaxAssistantSource({ ...sourceDraft, keywords: sourceDraft.keywords.split(/[،,]/).map((item) => item.trim()).filter(Boolean) });
      setSourceDraft({ title: '', issuer: '', officialUrl: '', summary: '', keywords: '', versionLabel: '', effectiveFrom: '', effectiveTo: '', verifiedAt: '' });
      await load(); notify('منبع رسمی نسخه‌دار ذخیره شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const resolveQuestion = async (item) => {
    const activeSources = sources.filter((source) => !source.expired && source.status === 'active');
    if (!activeSources.length) return notify('قبل از پاسخ متخصص، دست‌کم یک منبع رسمی فعال ثبت کن.');
    const answer = window.prompt('پاسخ بررسی‌شدهٔ متخصص را بنویس. منبع فعال اول به پاسخ پیوست می‌شود:');
    if (!answer?.trim()) return;
    setBusy(true);
    try { await api.resolveTaxAssistantQuestion(item.id, { answer, sourceIds: [activeSources[0].id] }); await load(); notify('پاسخ متخصص همراه snapshot منبع ثبت شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  return <section className="mt-5 rounded-[12px] border border-accent/30 bg-warn-bg p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Sparkles size={19} className="text-accent" /><h2 className="font-extrabold">دستیار مالیاتی منبع‌دار</h2></div><p className="mt-2 max-w-2xl text-xs leading-6 text-muted">پاسخ خودکار فقط از خلاصهٔ تأییدشدهٔ منابع رسمی فعال ساخته می‌شود. سؤال پرونده‌ای، جریمه، معافیت یا اعتراض مستقیماً به متخصص ارجاع می‌شود.</p></div><span className="rounded-full border border-accent/30 bg-surface px-3 py-1 text-[10px] font-bold text-accent">بدون اقدام یا ارسال خودکار</span></div>
    <form onSubmit={ask} className="mt-4 rounded-lg border border-line bg-surface p-3"><textarea required minLength={8} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="مثلاً این هزینه طبق منبع رسمی چه شرایط عمومی‌ای دارد؟" className="min-h-20 w-full rounded-lg border border-line p-3 text-sm" /><div className="mt-2 flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs font-bold"><input type="radio" checked={questionKind === 'general'} onChange={() => setQuestionKind('general')} />اطلاعات عمومی</label><label className="flex items-center gap-2 text-xs font-bold"><input type="radio" checked={questionKind === 'case'} onChange={() => setQuestionKind('case')} />مربوط به پرونده من</label><button disabled={busy} className="tap mr-auto rounded-lg bg-ink px-5 text-sm font-bold text-white disabled:opacity-40">ثبت سؤال</button></div></form>
    <div className="mt-4 space-y-3">{items.slice(0, 10).map((item) => <article key={item.id} className="rounded-lg border border-line bg-surface p-3"><div className="flex items-start justify-between gap-3"><p className="text-sm font-bold leading-6">{item.question}</p><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${item.status === 'referred' ? 'bg-expense/10 text-expense' : 'bg-income/10 text-income'}`}>{item.status === 'referred' ? 'نیازمند متخصص' : item.status === 'resolved' ? 'پاسخ متخصص' : 'پاسخ منبع‌دار'}</span></div>{item.answer ? <p className="mt-3 whitespace-pre-line rounded-lg bg-paper px-3 py-2 text-xs leading-6">{item.answer}</p> : <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-expense">{item.referralReason}</p>}<div className="mt-3 flex flex-wrap gap-2">{item.sources?.map((source) => <a key={`${item.id}-${source.id}`} href={source.officialUrl} target="_blank" rel="noreferrer" className="rounded-md border border-line px-2 py-1 text-[10px] font-bold text-accent">{source.title} · {source.versionLabel} · معتبر از {toPersianDigits(source.effectiveFrom)}</a>)}</div>{canManage && item.status === 'referred' && <button disabled={busy} onClick={() => resolveQuestion(item)} className="tap mt-3 rounded-lg border border-accent px-3 text-xs font-bold text-accent disabled:opacity-40">ثبت پاسخ متخصص با منبع فعال</button>}<p className="mt-3 border-t border-line pt-2 text-[10px] leading-5 text-muted">{item.disclaimer}</p></article>)}</div>
    {canManage && <details className="mt-4 border-t border-accent/20 pt-3"><summary className="cursor-pointer text-xs font-extrabold">مدیریت منابع رسمی ({toPersianDigits(sources.length)})</summary><form onSubmit={saveSource} className="mt-3 grid gap-2 rounded-lg bg-surface p-3 sm:grid-cols-2"><input required value={sourceDraft.title} onChange={(event) => setSourceDraft({ ...sourceDraft, title: event.target.value })} placeholder="عنوان قانون یا بخشنامه" className="tap rounded-lg border border-line px-3" /><input required value={sourceDraft.issuer} onChange={(event) => setSourceDraft({ ...sourceDraft, issuer: event.target.value })} placeholder="صادرکننده رسمی" className="tap rounded-lg border border-line px-3" /><input required type="url" dir="ltr" value={sourceDraft.officialUrl} onChange={(event) => setSourceDraft({ ...sourceDraft, officialUrl: event.target.value })} placeholder="https://..." className="tap rounded-lg border border-line px-3 text-left" /><input required value={sourceDraft.versionLabel} onChange={(event) => setSourceDraft({ ...sourceDraft, versionLabel: event.target.value })} placeholder="نسخه / شماره ابلاغ" className="tap rounded-lg border border-line px-3" /><input required type="date" value={sourceDraft.effectiveFrom} onChange={(event) => setSourceDraft({ ...sourceDraft, effectiveFrom: event.target.value })} className="tap numbers rounded-lg border border-line px-3" /><input type="date" value={sourceDraft.effectiveTo} onChange={(event) => setSourceDraft({ ...sourceDraft, effectiveTo: event.target.value })} className="tap numbers rounded-lg border border-line px-3" /><input required type="date" value={sourceDraft.verifiedAt} onChange={(event) => setSourceDraft({ ...sourceDraft, verifiedAt: event.target.value })} className="tap numbers rounded-lg border border-line px-3" /><input required value={sourceDraft.keywords} onChange={(event) => setSourceDraft({ ...sourceDraft, keywords: event.target.value })} placeholder="کلیدواژه‌ها با ویرگول" className="tap rounded-lg border border-line px-3" /><textarea required value={sourceDraft.summary} onChange={(event) => setSourceDraft({ ...sourceDraft, summary: event.target.value })} placeholder="خلاصهٔ تأییدشده‌ای که مجاز است در پاسخ نمایش داده شود" className="min-h-24 rounded-lg border border-line p-3 sm:col-span-2" /><button disabled={busy} className="tap rounded-lg bg-accent font-bold text-white sm:col-span-2 disabled:opacity-40">ذخیره منبع نسخه‌دار</button></form><div className="mt-2 space-y-2">{sources.map((source) => <div key={source.id} className="rounded-lg bg-surface px-3 py-2 text-xs"><a href={source.officialUrl} target="_blank" rel="noreferrer" className="font-bold text-accent">{source.title}</a><p className="mt-1 text-[10px] text-muted">{source.issuer} · {source.versionLabel} · {source.expired ? 'منقضی/غیرفعال' : 'فعال'} · بازبینی {toPersianDigits(source.verifiedAt)}</p></div>)}</div></details>}
  </section>;
}
