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

function tehranWeekStart(now = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', weekday: 'short' }).format(now);
  const daysSinceMonday = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] || 0;
  const monday = new Date(now.getTime() - daysSinceMonday * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(monday);
}

export function CollaborationPage({ access, notify, navigate }) {
  const [month, setMonth] = useState(() => persianPeriodToken());
  const [transferTarget, setTransferTarget] = useState('generic-csv');
  const periodOptions = useMemo(() => recentPersianPeriods(), []);
  const [overview, setOverview] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const [operations, setOperations] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [requestDraft, setRequestDraft] = useState({ entityType: 'general', entityId: '', question: '', priority: 'normal' });
  const [answers, setAnswers] = useState({});
  const monday = useMemo(() => tehranWeekStart(), []);
  const [checkin, setCheckin] = useState({ weekStart: monday, respondentType: 'owner', savedMinutes: '', errorCount: '', friction: '', dropoutReason: '', willingnessToPay: 'unknown', planInterest: 'none', note: '' });
  const role = access.workspace?.role;
  const canAnswer = ['owner', 'manager'].includes(role);
  const canManagePilot = ['owner', 'manager'].includes(role);
  // این صفحه چهار کار بی‌ربط را زیر یک عنوان جمع کرده بود و سه بخشش هم اسم
  // «انتقال» داشتند. هر برگه حالا یک کار است، نه یک دیوار عمودی.
  const [tab, setTab] = useState('delivery');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [collaboration, transferState, operationState, portfolioState] = await Promise.all([
        api.collaborationOverview(month),
        api.accountingTransferOverview(month, transferTarget),
        canManagePilot ? api.operationsOverview() : Promise.resolve(null),
        access.user?.isSystemAdmin ? api.pilotPortfolio() : Promise.resolve(null),
      ]);
      setOverview(collaboration);
      setTransfer(transferState);
      setOperations(operationState);
      setPortfolio(portfolioState);
    } catch (error) { notify(error.message); }
    finally { setLoading(false); }
  }, [access.user?.isSystemAdmin, canManagePilot, month, notify, transferTarget]);

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
  const saveCheckin = async (event) => {
    event.preventDefault();
    try {
      await api.savePilotCheckin({ ...checkin, savedMinutes: Number(checkin.savedMinutes || 0), errorCount: Number(checkin.errorCount || 0) });
      await load();
      notify('مصاحبهٔ هفتگی پایلوت ثبت شد.');
    } catch (error) { notify(error.message); }
  };
  const downloadPackage = async () => {
    try { const result = await api.downloadMonthlyAccountantPackage(month); notify(`بستهٔ ${result.fileName} ساخته شد.`); }
    catch (error) { notify(error.message); }
  };
  const updatePlan = async (workspaceId, planId, budgetUsd) => {
    try { await api.updateWorkspacePlan(workspaceId, { planId, providerBudgetUsd: Number(budgetUsd || 0) }); await load(); notify('پلن و سقف بودجهٔ دفتر به‌روزرسانی شد.'); }
    catch (error) { notify(error.message); }
  };

  if (loading && !overview) return <main className="mx-auto w-full max-w-[980px] px-4 py-6"><div className="h-28 animate-pulse rounded-[12px] bg-surface" /></main>;
  const packageData = overview?.package || {};
  const commercial = overview?.commercial || {};
  const pilot = overview?.pilot || {};
  const cost = commercial.provider || {};
  const entityLabels = { general: 'پرسش عمومی', transaction: 'تراکنش', receipt: 'رسید', closing: 'بستن صندوق', reconciliation: 'تطبیق بانکی', obligation: 'طلب یا بدهی' };

  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-bold text-accent">فاز همکاری واقعی</p><h1 className="mt-1 text-xl font-extrabold">همکاری حسابدار، پایلوت و هزینه</h1><p className="mt-2 max-w-[700px] text-[13px] leading-6 text-muted">حساب‌یار در این بخش پل بین صاحب کسب‌وکار و دفتر حسابداری است؛ ثبت اولیه، مدرک و سؤال جابه‌جا می‌شود، اما جای نرم‌افزار رسمی حسابداری را نمی‌گیرد.</p></div><label className="text-xs text-muted">دورهٔ شمسی بسته<select value={month} onChange={(event) => setMonth(event.target.value)} className="tap mt-2 block rounded-lg border border-line bg-surface px-3 text-ink">{periodOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>

    <div className="mt-6 flex flex-wrap gap-1.5 border-b border-line pb-2 text-[13px] font-bold">
      {[['delivery', 'تحویل به حسابدار'], ['dna', 'DNA مالی'], ['questions', 'سؤال و پاسخ'], ['plan', 'پلن و هزینه'], ...(canManagePilot ? [['pilot', 'پایلوت و سلامت']] : [])].map(([id, label]) => (
        <button key={id} onClick={() => setTab(id)} className={`tap rounded-lg px-3 ${tab === id ? 'bg-warn-bg text-accent' : 'text-muted hover:bg-surface'}`}>{label}</button>
      ))}
    </div>

    {tab === 'delivery' && <div className="mt-4">
      <DeliverySpine readiness={transfer?.readiness} targetLabel={(transfer?.targets || []).find((item) => item.id === transferTarget)?.label || ''} />

      {/* گام ۱ و ۲ — تنظیمی که یک بار انجام می‌شود و بعد جمع می‌ماند. */}
      <TransferSetupSection readiness={transfer?.readiness}>
        <TransferLayoutPanel target={transferTarget} settings={transfer?.settings} readiness={transfer?.readiness} notify={notify} refresh={load} />
      </TransferSetupSection>

      {/* گام ۳ و ۴ — کار هر ماه: کنترل داده، ساخت بسته، ثبت آزمون ورود. */}
      <AccountingTransferPanel month={month} target={transferTarget} setTarget={setTransferTarget} overview={transfer} notify={notify} refresh={load} navigate={navigate} />

      {/* تحویل جداگانه: بستهٔ JSON مرور حسابدار، نه فایل انتقال نرم‌افزار. */}
      <section className="rounded-[12px] border border-line bg-surface p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">بستهٔ پایان ماه برای حسابدار</h2><p className="mt-1 text-xs leading-6 text-muted">تراکنش‌ها، رسید ناقص، اختلاف صندوق، تطبیق باز، طلب/بدهی و سابقهٔ حسابرسی با شناسهٔ منبع.</p></div><FileText size={22} className="shrink-0 text-accent" /></div><div className="mt-4 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-[11px] text-muted">ثبت‌ها</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.transactionCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[11px] text-muted">رسید ناقص</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.incompleteReceipts || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[11px] text-muted">سؤال بی‌پاسخ</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.unansweredRequests || 0)}</b></div></div><div className="mt-4 divide-y divide-line rounded-lg border border-line px-3">{packageData.checklist?.checks?.map((item) => <div key={item.id} className="flex min-h-11 items-center gap-2 py-2 text-xs"><span className={`grid h-5 w-5 place-items-center rounded-full ${item.passed ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>{item.passed ? <Check size={14} /> : <CircleAlert size={14} />}</span><span className="flex-1 font-bold">{item.label}</span>{!item.passed && <b className="numbers text-expense">{toPersianDigits(item.count)}</b>}</div>)}</div><button onClick={downloadPackage} className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-ink font-bold text-white"><Download size={18} />دریافت بسته JSON حسابدار</button><p className="mt-3 text-[10px] leading-5 text-muted">هش SHA-256 داخل manifest امکان کنترل تغییر فایل را می‌دهد. تصویر خام رسید داخل خروجی قرار نمی‌گیرد.</p></section>
    </div>}

    {tab === 'dna' && <FinancialDnaPanel notify={notify} />}

    {tab === 'questions' && <section className="mt-4 rounded-[12px] border border-line bg-surface p-4"><div className="flex items-center justify-between"><div><h2 className="font-extrabold">صندوق درخواست توضیح</h2><p className="mt-1 text-xs leading-6 text-muted">حسابدار سؤال را به یک منبع وصل می‌کند؛ مدیر یا مالک پاسخ می‌دهد و حسابدار پس از کنترل آن را می‌بندد.</p></div><Users size={22} className="text-accent" /></div><form onSubmit={createRequest} className="mt-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)_110px]"><select value={requestDraft.entityType} onChange={(event) => setRequestDraft({ ...requestDraft, entityType: event.target.value, entityId: '' })} className="tap rounded-lg border border-line bg-surface px-3 text-sm">{Object.entries(entityLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>{requestDraft.entityType === 'general' ? <input required minLength={5} value={requestDraft.question} onChange={(event) => setRequestDraft({ ...requestDraft, question: event.target.value })} placeholder="مثلاً این پرداخت بابت کدام پروژه بود؟" className="tap rounded-lg border border-line px-3" /> : <div className="grid gap-2 sm:grid-cols-[160px_1fr]"><input required value={requestDraft.entityId} onChange={(event) => setRequestDraft({ ...requestDraft, entityId: event.target.value })} placeholder="شناسه منبع" dir="ltr" className="tap rounded-lg border border-line px-3 text-left text-xs" /><input required minLength={5} value={requestDraft.question} onChange={(event) => setRequestDraft({ ...requestDraft, question: event.target.value })} placeholder="سؤال حسابدار" className="tap rounded-lg border border-line px-3" /></div>}<button className="tap rounded-lg bg-accent px-3 text-sm font-bold text-white">ثبت درخواست</button><label className="flex items-center gap-2 text-xs md:col-span-3"><input type="checkbox" checked={requestDraft.priority === 'urgent'} onChange={(event) => setRequestDraft({ ...requestDraft, priority: event.target.checked ? 'urgent' : 'normal' })} />فوری است</label></form><div className="mt-5 space-y-3">{overview?.requests?.length ? overview.requests.map((item) => <article key={item.id} className={`rounded-lg border p-3 ${item.priority === 'urgent' && item.status !== 'resolved' ? 'border-expense/30 bg-expense/5' : 'border-line'}`}><div className="flex flex-wrap items-center gap-2 text-[11px]"><b>{entityLabels[item.entityType]}</b><span className="rounded-md bg-paper px-2 py-1">{item.status === 'open' ? 'منتظر پاسخ' : item.status === 'answered' ? 'پاسخ داده‌شده' : 'بسته'}</span><span className="text-muted">{item.requestedBy?.label} · {persianDate(item.createdAt)}</span></div><p className="mt-3 text-sm font-bold leading-6">{item.question}</p>{item.entityId && <p className="mt-1 truncate text-[10px] text-muted" dir="ltr">{item.entityId}</p>}{item.answer && <div className="mt-3 rounded-lg bg-paper px-3 py-2"><p className="text-[11px] text-muted">پاسخ {item.answeredBy?.label}</p><p className="mt-1 text-sm leading-6">{item.answer}</p></div>}{item.status === 'open' && canAnswer && <div className="mt-3 flex gap-2"><input value={answers[item.id] || ''} onChange={(event) => setAnswers({ ...answers, [item.id]: event.target.value })} placeholder="پاسخ مستند صاحب کسب‌وکار" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button disabled={!String(answers[item.id] || '').trim()} onClick={() => answer(item.id)} className="tap rounded-lg bg-ink px-3 text-xs font-bold text-white disabled:opacity-40">ثبت پاسخ</button></div>}{item.status === 'answered' && <button onClick={() => resolveRequest(item.id)} className="tap mt-3 rounded-lg border border-income/30 px-3 text-xs font-bold text-income">کنترل شد؛ بستن درخواست</button>}</article>) : <p className="rounded-lg bg-paper px-3 py-4 text-center text-xs text-muted">درخواست بازی وجود ندارد.</p>}</div></section>}

    {tab === 'plan' && <div className="mt-4">
      <section className="rounded-[12px] border border-line bg-surface p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">پلن و مصرف ماه</h2><p className="mt-1 text-xs text-muted">{commercial.plan?.label || 'رایگان'} · {commercial.plan?.description}</p></div><HandCoins size={22} className="text-accent" /></div><div className="mt-4 space-y-4">{commercial.quotas?.map((item) => <div key={item.id}><div className="flex justify-between text-xs"><span className="font-bold">{item.label}</span><span className={item.exhausted ? 'text-expense' : 'text-muted'}>{toPersianDigits(item.used)} از {toPersianDigits(item.limit)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-paper"><div className={`h-full rounded-full ${item.percent >= 90 ? 'bg-expense' : 'bg-accent'}`} style={{ width: `${item.percent}%` }} /></div>{item.note && <p className="mt-1 text-[10px] leading-5 text-muted">{item.note}</p>}</div>)}</div><div className="mt-4 border-t border-line pt-4"><div className="flex justify-between text-sm"><span className="text-muted">هزینهٔ تخمینی provider</span><b dir="ltr">${Number(cost.estimatedCostUsd || 0).toFixed(4)}</b></div>{cost.budgetUsd > 0 && <div className="mt-2 flex justify-between text-xs"><span className="text-muted">سقف بودجه</span><b dir="ltr">${Number(cost.budgetUsd).toFixed(2)}</b></div>}{!cost.pricingComplete && <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[11px] leading-5 text-expense">بعضی نرخ‌های provider در Railway تنظیم نشده‌اند؛ جمع هزینه کامل نیست و به‌عنوان عدد قطعی نمایش داده نمی‌شود.</p>}<p className="mt-3 text-[11px] font-bold leading-5 text-income">{commercial.coreEntryMessage}</p></div></section>
    </div>}

    {tab === 'pilot' && <>
      {canManagePilot && <div className="mt-4 grid gap-4 lg:grid-cols-2"><section className="rounded-[12px] border border-line bg-surface p-4"><h2 className="font-extrabold">مصاحبهٔ هفتگی پایلوت</h2><p className="mt-1 text-xs leading-6 text-muted">زمان صرفه‌جویی، خطا و علت ترک را ثبت کن؛ این داده را حدس نزن.</p><form onSubmit={saveCheckin} className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-muted">شروع هفته<input required type="date" value={checkin.weekStart} onChange={(event) => setCheckin({ ...checkin, weekStart: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><label className="text-xs text-muted">مصاحبه‌شونده<select value={checkin.respondentType} onChange={(event) => setCheckin({ ...checkin, respondentType: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line px-3"><option value="owner">صاحب کسب‌وکار</option><option value="accountant">حسابدار</option></select></label><input inputMode="numeric" value={checkin.savedMinutes} onChange={(event) => setCheckin({ ...checkin, savedMinutes: event.target.value.replace(/\D/g, '') })} placeholder="دقیقه صرفه‌جویی" className="tap rounded-lg border border-line px-3" /><input inputMode="numeric" value={checkin.errorCount} onChange={(event) => setCheckin({ ...checkin, errorCount: event.target.value.replace(/\D/g, '') })} placeholder="تعداد خطا" className="tap rounded-lg border border-line px-3" /><select value={checkin.willingnessToPay} onChange={(event) => setCheckin({ ...checkin, willingnessToPay: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="unknown">آمادگی پرداخت نامشخص</option><option value="yes">حاضر به پرداخت</option><option value="maybe">شاید پرداخت کند</option><option value="no">حاضر به پرداخت نیست</option></select><select value={checkin.planInterest} onChange={(event) => setCheckin({ ...checkin, planInterest: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="none">پلن انتخاب نشده</option><option value="free">رایگان</option><option value="professional">حرفه‌ای</option><option value="accountant">همکاری حسابدار</option></select><textarea value={checkin.friction} onChange={(event) => setCheckin({ ...checkin, friction: event.target.value })} placeholder="بزرگ‌ترین اصطکاک این هفته" className="min-h-20 rounded-lg border border-line p-3 text-sm sm:col-span-2" /><textarea value={checkin.dropoutReason} onChange={(event) => setCheckin({ ...checkin, dropoutReason: event.target.value })} placeholder="اگر استفاده نکرد، دلیل ترک" className="min-h-20 rounded-lg border border-line p-3 text-sm sm:col-span-2" /><button className="tap rounded-lg bg-accent font-bold text-white sm:col-span-2">ثبت دادهٔ واقعی هفته</button></form></section><section className="rounded-[12px] border border-line bg-surface p-4"><h2 className="font-extrabold">سلامت دفتر و پایلوت</h2><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">هفته فعال از ۴</span><b className="numbers mt-2 block text-lg">{toPersianDigits(pilot.activeWeeks || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">دقیقه صرفه‌جویی گزارش‌شده</span><b className="numbers mt-2 block text-lg">{toPersianDigits(pilot.savedMinutes || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">پایگاه‌داده</span><b className={`mt-2 block text-sm ${operations?.database?.ok ? 'text-income' : 'text-expense'}`}>{operations?.database?.ok ? 'سالم' : 'نیازمند بررسی'}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">پشتیبان خودکار</span><b className={`mt-2 block text-sm ${operations?.backup?.healthy ? 'text-income' : 'text-expense'}`}>{operations?.backup?.healthy ? 'کمتر از ۳۰ ساعت' : 'تأیید نشده'}</b></div></div><p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-xs leading-6 text-muted">«بکاپ نوشته شد» مساوی «بازیابی عملی شد» نیست. آخرین بازیابی واقعی: {operations?.lastRestoreAt ? persianDate(operations.lastRestoreAt) : 'هنوز ثبت نشده'}.</p></section></div>}
      {portfolio && <PilotPortfolioPanel portfolio={portfolio} updatePlan={updatePlan} />}
    </>}
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
      return <li key={step.id} className={`rounded-[10px] border p-3 ${tone}`}>
        <div className="flex items-center gap-2">
          <span className={`numbers grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-extrabold ${mark}`}>
            {step.blocking ? <CircleAlert size={14} /> : step.done ? <Check size={14} /> : toPersianDigits(order + 1)}
          </span>
          <b className="text-[13px]">{step.title}</b>
          {step.blocking > 0 && <span className="numbers mr-auto text-[11px] font-bold text-expense">{toPersianDigits(step.blocking)} مورد</span>}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted">{step.hint}</p>
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
  return <section className="mt-4 rounded-[12px] border border-line bg-surface">
    <button onClick={() => setOpen(!expanded)} className="tap flex w-full items-center gap-3 px-4 py-3 text-right">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${blocking.length ? 'bg-expense/10 text-expense' : 'bg-income/10 text-income'}`}>
        {blocking.length ? <CircleAlert size={16} /> : <Check size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[14px]">تنظیم مقصد — یک بار انجام می‌شود</b>
        <span className="mt-0.5 block text-[11px] leading-5 text-muted">
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

function PilotPortfolioPanel({ portfolio, updatePlan }) {
  const [drafts, setDrafts] = useState({});
  const summary = portfolio.summary || {};
  return <section className="mt-4 rounded-[12px] border border-line bg-surface p-4"><h2 className="font-extrabold">داشبورد مدیر پایلوت</h2><p className="mt-1 text-xs leading-6 text-muted">نرخ‌ها فقط از رفتار و مصاحبهٔ ثبت‌شدهٔ دفترها ساخته می‌شوند؛ دفترهای کمتر از چهار هفته وارد مخرج ماندگاری نمی‌شوند.</p><div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">دفتر پایلوت</span><b className="numbers mt-2 block">{toPersianDigits(summary.workspaceCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">واجد هفته چهارم</span><b className="numbers mt-2 block">{toPersianDigits(summary.eligibleWeekFour || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">ماندگاری / هدف ۴۰٪</span><b className="numbers mt-2 block">{summary.retentionPercent == null ? '—' : `${toPersianDigits(summary.retentionPercent)}٪`}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">آمادگی پرداخت / هدف ۳۰٪</span><b className="numbers mt-2 block">{summary.willingnessPercent == null ? '—' : `${toPersianDigits(summary.willingnessPercent)}٪`}</b></div></div><div className="mt-4 divide-y divide-line border-y border-line">{portfolio.workspaces?.map((item) => { const draft = drafts[item.workspace.id] || { planId: item.commercial.plan.id, budgetUsd: item.commercial.provider.budgetUsd }; return <div key={item.workspace.id} className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_150px_130px_100px]"><div><p className="text-sm font-bold">{item.workspace.name}</p><p className="mt-1 text-[11px] text-muted">{toPersianDigits(item.activeWeeks)} هفته فعال · {item.willingnessToPay === 'yes' ? 'حاضر به پرداخت' : 'پرداخت تأیید نشده'}</p></div><select value={draft.planId} onChange={(event) => setDrafts({ ...drafts, [item.workspace.id]: { ...draft, planId: event.target.value } })} className="tap rounded-lg border border-line px-2 text-xs"><option value="free">رایگان</option><option value="professional">حرفه‌ای</option><option value="accountant">همکاری حسابدار</option></select><input type="number" min="0" step="0.01" value={draft.budgetUsd} onChange={(event) => setDrafts({ ...drafts, [item.workspace.id]: { ...draft, budgetUsd: event.target.value } })} placeholder="بودجه دلار" dir="ltr" className="tap rounded-lg border border-line px-2 text-left text-xs" /><button onClick={() => updatePlan(item.workspace.id, draft.planId, draft.budgetUsd)} className="tap rounded-lg bg-ink px-2 text-xs font-bold text-white">ذخیره پلن</button></div>; })}</div></section>;
}
