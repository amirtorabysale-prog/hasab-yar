import { Check, ChevronLeft, CircleAlert, Download, FileText, HandCoins, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountingTransferPanel, TransferLayoutPanel } from './AccountingTransferPanel.jsx';
import { FinancialDnaPanel } from '../dna/FinancialDnaPanel.jsx';
import { SETUP_CHECK_IDS, deliverySteps } from '../../lib/deliveryFlow.js';
import { api } from '../../lib/api.js';
import { persianDate, toPersianDigits } from '../../lib/format.js';

function persianPeriodToken(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

function recentPersianPeriods(now = new Date(), count = 12) {
  const items = [];
  const seen = new Set();
  for (let offset = 0; offset < 420 && items.length < count; offset += 1) {
    const date = new Date(now.getTime() - offset * 86_400_000);
    const id = persianPeriodToken(date);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long' }).format(date) });
  }
  return items;
}


const COLLABORATION_TABS = ['delivery', 'dna', 'questions'];

export function CollaborationPage({ access, notify, navigate, initialTab = '' }) {
  const [month, setMonth] = useState(() => persianPeriodToken());
  const [transferTarget, setTransferTarget] = useState('generic-csv');
  const periodOptions = useMemo(() => recentPersianPeriods(), []);
  const [overview, setOverview] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [requestDraft, setRequestDraft] = useState({ entityType: 'general', entityId: '', question: '', priority: 'normal' });
  const [answers, setAnswers] = useState({});
  const role = access.workspace?.role;
  const canAnswer = ['owner', 'manager'].includes(role);
  // این صفحه چهار کار بی‌ربط را زیر یک عنوان جمع کرده بود و سه بخشش هم اسم
  // «انتقال» داشتند. هر برگه حالا یک کار است، نه یک دیوار عمودی.
  const [tab, setTab] = useState(COLLABORATION_TABS.includes(initialTab) ? initialTab : 'delivery');
  useEffect(() => { if (COLLABORATION_TABS.includes(initialTab)) setTab(initialTab); }, [initialTab]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [collaboration, transferState] = await Promise.all([
        api.collaborationOverview(month),
        api.accountingTransferOverview(month, transferTarget),
      ]);
      setOverview(collaboration);
      setTransfer(transferState);
    } catch (error) { notify(error.message); }
    finally { setLoading(false); }
  }, [month, notify, transferTarget]);

  useEffect(() => { load(); }, [load]);

  const createRequest = async (event) => {
    event.preventDefault();
    try {
      await api.createCollaborationRequest(requestDraft);
      setRequestDraft({ entityType: 'general', entityId: '', question: '', priority: 'normal' });
      await load();
      notify('درخواست توضیح در صندوق همکاری ثبت شد.');
    } catch (error) { notify(error.message); }
  };
  const answer = async (id) => {
    try { await api.answerCollaborationRequest(id, answers[id]); setAnswers({ ...answers, [id]: '' }); await load(); notify('پاسخ ثبت شد و برای حسابدار قابل مشاهده است.'); }
    catch (error) { notify(error.message); }
  };
  const resolveRequest = async (id) => {
    try { await api.resolveCollaborationRequest(id); await load(); notify('درخواست بسته شد و در سابقه باقی ماند.'); }
    catch (error) { notify(error.message); }
  };
  const downloadPackage = async () => {
    try { const result = await api.downloadMonthlyAccountantPackage(month); notify(`بستهٔ ${result.fileName} ساخته شد.`); }
    catch (error) { notify(error.message); }
  };

  if (loading && !overview) return <main className="mx-auto w-full max-w-[980px] px-4 py-6"><div className="h-28 animate-pulse rounded-2xl bg-surface" /></main>;
  const packageData = overview?.package || {};
  const entityLabels = { general: 'پرسش عمومی', transaction: 'تراکنش', receipt: 'رسید', closing: 'بستن صندوق', reconciliation: 'تطبیق بانکی', obligation: 'طلب یا بدهی' };

  const TABS = [['delivery', 'تحویل به حسابدار'], ['questions', 'سؤال و پاسخ'], ['dna', 'DNA مالی']];
  const openRequests = (overview?.requests || []).filter((item) => item.status !== 'resolved').length;
  // تب‌ها همان برگ‌های منو هستند؛ تعویضشان نشانی را هم عوض می‌کند تا «بازگشت» کار کند.
  const openTab = (id) => (navigate ? navigate('collaboration', id) : setTab(id));
  const monthPicker = <label className="flex items-center gap-2 text-xs font-bold text-muted">دورهٔ تحویل
    <select value={month} onChange={(event) => setMonth(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm text-ink">{periodOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
  </label>;

  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <header>
      <h1 className="text-xl font-extrabold">همکاری با حسابدار</h1>
      <p className="mt-1 max-w-[680px] text-sm leading-7 text-muted">تحویل ماهانه به نرم‌افزار حسابدار، پرسش و پاسخ دربارهٔ ثبت‌ها، و الگوی مالی همین پرونده. ثبت رسمی همچنان در نرم‌افزار حسابدار است.</p>
    </header>

    <nav aria-label="بخش‌های همکاری" className="section-navigation">
      {TABS.map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => openTab(id)}>
        {label}{id === 'questions' && openRequests > 0 && <span className="numbers mr-1.5 rounded-full bg-expense/10 px-1.5 text-xs text-expense">{toPersianDigits(openRequests)}</span>}
      </button>)}
    </nav>

    {tab !== 'dna' && <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs leading-6 text-muted">{tab === 'delivery' ? 'چهار گام به ترتیب کار واقعی؛ هر گامی که جلوی تحویل را گرفته قرمز است.' : 'هر سؤال به یک ثبت وصل است؛ مالک پاسخ می‌دهد و حسابدار پس از کنترل می‌بندد.'}</p>
      {monthPicker}
    </div>}

    {tab === 'delivery' && <div className="mt-2">
      <DeliverySpine readiness={transfer?.readiness} targetLabel={(transfer?.targets || []).find((item) => item.id === transferTarget)?.label || ''} />

      {/* گام ۱ و ۲ — تنظیمی که یک بار انجام می‌شود و بعد جمع می‌ماند. */}
      <TransferSetupSection readiness={transfer?.readiness}>
        <TransferLayoutPanel target={transferTarget} settings={transfer?.settings} readiness={transfer?.readiness} notify={notify} refresh={load} />
      </TransferSetupSection>

      {/* گام ۳ و ۴ — کار هر ماه: کنترل داده، ساخت بسته، ثبت آزمون ورود. */}
      <AccountingTransferPanel month={month} target={transferTarget} setTarget={setTransferTarget} overview={transfer} notify={notify} refresh={load} navigate={navigate} />

      {/* تحویل جداگانه: بستهٔ JSON مرور حسابدار، نه فایل انتقال نرم‌افزار. */}
      <section className="mt-4 rounded-2xl border border-line bg-surface p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">بستهٔ مرور ماهانه (JSON)</h2><p className="mt-1 text-xs leading-6 text-muted">تراکنش‌ها، رسید ناقص، اختلاف صندوق، تطبیق باز، طلب/بدهی و سابقهٔ حسابرسی با شناسهٔ منبع.</p></div><FileText size={22} className="shrink-0 text-accent" /></div><div className="mt-4 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">ثبت‌ها</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.transactionCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">رسید ناقص</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.incompleteReceipts || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">سؤال بی‌پاسخ</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.unansweredRequests || 0)}</b></div></div><div className="mt-4 divide-y divide-line rounded-lg border border-line px-3">{packageData.checklist?.checks?.map((item) => <div key={item.id} className="flex min-h-11 items-center gap-2 py-2 text-xs"><span className={`grid h-5 w-5 place-items-center rounded-full ${item.passed ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>{item.passed ? <Check size={14} /> : <CircleAlert size={14} />}</span><span className="flex-1 font-bold">{item.label}</span>{!item.passed && <b className="numbers text-expense">{toPersianDigits(item.count)}</b>}</div>)}</div><button onClick={downloadPackage} className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-ink font-bold text-on-fill hover:bg-ink/90"><Download size={18} />دریافت بسته JSON حسابدار</button><p className="mt-3 text-xs leading-5 text-muted">هش SHA-256 داخل manifest امکان کنترل تغییر فایل را می‌دهد. تصویر خام رسید داخل خروجی قرار نمی‌گیرد.</p></section>
    </div>}

    {tab === 'dna' && <FinancialDnaPanel notify={notify} />}

    {tab === 'questions' && <section className="mt-2 rounded-2xl border border-line bg-surface p-4"><div className="flex items-center justify-between"><div><h2 className="font-extrabold">صندوق درخواست توضیح</h2><p className="mt-1 text-xs leading-6 text-muted">حسابدار سؤال را به یک منبع وصل می‌کند؛ مدیر یا مالک پاسخ می‌دهد و حسابدار پس از کنترل آن را می‌بندد.</p></div><Users size={22} className="text-accent" /></div><div className="mt-4 space-y-3">{overview?.requests?.length ? overview.requests.map((item) => <article key={item.id} className={`rounded-lg border p-3 ${item.priority === 'urgent' && item.status !== 'resolved' ? 'border-expense/30 bg-expense/5' : 'border-line'}`}><div className="flex flex-wrap items-center gap-2 text-xs"><b>{entityLabels[item.entityType]}</b><span className="rounded-md bg-paper px-2 py-1">{item.status === 'open' ? 'منتظر پاسخ' : item.status === 'answered' ? 'پاسخ داده‌شده' : 'بسته'}</span><span className="text-muted">{item.requestedBy?.label} · {persianDate(item.createdAt)}</span></div><p className="mt-3 text-sm font-bold leading-6">{item.question}</p>{item.entityId && <p className="mt-1 truncate text-xs text-muted" dir="ltr">{item.entityId}</p>}{item.answer && <div className="mt-3 rounded-lg bg-paper px-3 py-2"><p className="text-xs text-muted">پاسخ {item.answeredBy?.label}</p><p className="mt-1 text-sm leading-6">{item.answer}</p></div>}{item.status === 'open' && canAnswer && <div className="mt-3 flex gap-2"><input value={answers[item.id] || ''} onChange={(event) => setAnswers({ ...answers, [item.id]: event.target.value })} placeholder="پاسخ مستند صاحب کسب‌وکار" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button disabled={!String(answers[item.id] || '').trim()} onClick={() => answer(item.id)} className="tap rounded-lg bg-ink px-3 text-xs font-bold text-on-fill disabled:opacity-40 hover:bg-ink/90">ثبت پاسخ</button></div>}{item.status === 'answered' && <button onClick={() => resolveRequest(item.id)} className="tap mt-3 rounded-lg border border-income/30 px-3 text-xs font-bold text-income">کنترل شد؛ بستن درخواست</button>}</article>) : <p className="rounded-lg bg-paper px-3 py-4 text-center text-xs text-muted">درخواست بازی وجود ندارد.</p>}</div><div className="mt-6 border-t border-line pt-4"><h3 className="text-sm font-extrabold">سؤال تازه</h3><form onSubmit={createRequest} className="mt-3 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)_110px]"><select value={requestDraft.entityType} onChange={(event) => setRequestDraft({ ...requestDraft, entityType: event.target.value, entityId: '' })} className="tap rounded-lg border border-line bg-surface px-3 text-sm">{Object.entries(entityLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>{requestDraft.entityType === 'general' ? <input required minLength={5} value={requestDraft.question} onChange={(event) => setRequestDraft({ ...requestDraft, question: event.target.value })} placeholder="مثلاً این پرداخت بابت کدام پروژه بود؟" className="tap rounded-lg border border-line px-3" /> : <div className="grid gap-2 sm:grid-cols-[160px_1fr]"><input required value={requestDraft.entityId} onChange={(event) => setRequestDraft({ ...requestDraft, entityId: event.target.value })} placeholder="شناسه منبع" dir="ltr" className="tap rounded-lg border border-line px-3 text-left text-xs" /><input required minLength={5} value={requestDraft.question} onChange={(event) => setRequestDraft({ ...requestDraft, question: event.target.value })} placeholder="سؤال حسابدار" className="tap rounded-lg border border-line px-3" /></div>}<button className="tap rounded-lg bg-accent px-3 text-sm font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">ثبت درخواست</button><label className="flex items-center gap-2 text-xs md:col-span-3"><input type="checkbox" checked={requestDraft.priority === 'urgent'} onChange={(event) => setRequestDraft({ ...requestDraft, priority: event.target.checked ? 'urgent' : 'normal' })} />فوری است</label></form></div></section>}

  </main>;
}

/**
 * ستون فقرات صفحه: چهار گام به همان ترتیبی که کار واقعاً انجام می‌شود، تا
 * کاربر پیش از هر اسکرول بداند کجای کار است و چه چیزی جلویش را گرفته.
 */
function DeliverySpine({ readiness, targetLabel }) {
  const steps = deliverySteps(readiness, targetLabel);
  return <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
    {steps.map((step, order) => {
      const tone = step.blocking ? 'border-expense/30 bg-expense/5' : step.done ? 'border-income/30 bg-income/5' : 'border-line bg-surface';
      const mark = step.blocking ? 'bg-expense/10 text-expense' : step.done ? 'bg-income/10 text-income' : 'bg-paper text-muted';
      return <li key={step.id} className={`rounded-xl border p-3 ${tone}`}>
        <div className="flex items-center gap-2">
          <span className={`numbers grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-extrabold ${mark}`}>
            {step.blocking ? <CircleAlert size={14} /> : step.done ? <Check size={14} /> : toPersianDigits(order + 1)}
          </span>
          <b className="text-[13px]">{step.title}</b>
          {step.blocking > 0 && <span className="numbers mr-auto text-xs font-bold text-expense">{toPersianDigits(step.blocking)} مورد</span>}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">{step.hint}</p>
      </li>;
    })}
  </ol>;
}

/**
 * تنظیم مقصد یک کار یک‌باره است، نه کار ماهانه. وقتی درست شده باشد باید جمع
 * بماند تا آنچه هر ماه دیده می‌شود، فقط کار همان ماه باشد؛ و وقتی چیزی از آن
 * ناقص است، خودش باز شود تا کاربر دنبالش نگردد.
 */
function TransferSetupSection({ readiness, children }) {
  const checks = (readiness?.checks || []).filter((item) => SETUP_CHECK_IDS.includes(item.id));
  const blocking = checks.filter((item) => !item.passed && item.severity !== 'advisory');
  const [open, setOpen] = useState(null);
  const expanded = open === null ? blocking.length > 0 : open;
  return <section className="mt-4 rounded-2xl border border-line bg-surface">
    <button onClick={() => setOpen(!expanded)} className="tap flex w-full items-center gap-3 px-4 py-3 text-right">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${blocking.length ? 'bg-expense/10 text-expense' : 'bg-income/10 text-income'}`}>
        {blocking.length ? <CircleAlert size={16} /> : <Check size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[14px]">تنظیم مقصد — یک بار انجام می‌شود</b>
        <span className="mt-0.5 block text-xs leading-5 text-muted">
          {blocking.length
            ? `${toPersianDigits(blocking.length)} مورد باید تکمیل شود: ${blocking.map((item) => item.label).join('، ')}`
            : 'فایل پایه، چیدمان ستون‌ها، واحد مبلغ و سال مالی تنظیم شده‌اند.'}
        </span>
      </span>
      <ChevronLeft size={18} className={`shrink-0 text-muted transition-transform ${expanded ? '-rotate-90' : ''}`} />
    </button>
    {expanded && <div className="border-t border-line px-4 pb-4">{children}</div>}
  </section>;
}

