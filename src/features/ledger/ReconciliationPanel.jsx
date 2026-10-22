// برگهٔ «تطبیق بانک»: ورود صورت‌حساب بانک یا صندوق، بررسی ردیف‌ها و قواعد تأییدشده.
//
// از src/features/ledger/LedgerPage.jsx جدا شد؛ بدنهٔ کامپوننت‌ها دست نخورده است.

import BankVoicePanel from './BankVoicePanel.jsx';
import { Check, Landmark, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

export function ReconciliationPanel({ accounts = [], categories = [], notify, refresh }) {
  const eligibleAccounts = accounts.filter((account) => account.active && ['cash', 'bank', 'wallet'].includes(account.kind));
  const [imports, setImports] = useState([]);
  const [detail, setDetail] = useState(null);
  const [file, setFile] = useState(null);
  const [accountId, setAccountId] = useState(eligibleAccounts[0]?.id || 'cash');
  const [lineCategories, setLineCategories] = useState({});
  const [rules, setRules] = useState([]);
  const [busy, setBusy] = useState(false);
  const loadImports = useCallback(async () => { const result = await api.reconciliationImports(); setImports(result.items); }, []);
  const loadRules = useCallback(async () => { const result = await api.automationRules('bank_description'); setRules(result.items); }, []);
  useEffect(() => { Promise.all([loadImports(), loadRules()]).catch((error) => notify(error.message)); }, [loadImports, loadRules, notify]);
  const open = async (id) => { setBusy(true); try { setDetail((await api.reconciliationImport(id)).item); } catch (error) { notify(error.message); } finally { setBusy(false); } };
  const upload = async (event) => {
    event.preventDefault();
    if (!file) return notify('فایل CSV را انتخاب کن.');
    setBusy(true);
    try { const result = await api.importBankStatement(file, accountId); setDetail(result.item); setFile(null); await loadImports(); notify(`صورت‌حساب با قالب «${result.item.formatName}» وارد شد.`); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const applyResult = async (promise, message) => {
    setBusy(true);
    try { const result = await promise; setDetail(result.item); await loadImports(); refresh(); notify(message); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const match = (lineId, transactionId) => applyResult(api.matchReconciliationLine(lineId, transactionId), 'ردیف با تراکنش موجود تطبیق شد.');
  const create = (line) => applyResult(api.createFromReconciliationLine(line.id, lineCategories[line.id] || line.ruleSuggestion?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')), 'تراکنش ساخته و ردیف تطبیق شد.');
  const ignore = (line) => { const reason = window.prompt('چرا این ردیف نباید وارد دفتر شود؟ (حداقل ۵ نویسه)'); if (reason) applyResult(api.ignoreReconciliationLine(line.id, reason), 'ردیف با دلیل ثبت‌شده کنار گذاشته شد.'); };
  const learn = async (line) => {
    const pattern = window.prompt('عبارت ثابت و کوتاه داخل شرح بانک چیست؟', line.description.slice(0, 40));
    if (!pattern?.trim()) return;
    const category = lineCategories[line.id] || line.ruleSuggestion?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها');
    try { await api.saveAutomationRule({ source: 'bank_description', pattern, type: line.direction, category, accountId: detail.accountId }); await loadRules(); setDetail((await api.reconciliationImport(detail.id)).item); notify('قانون با تأیید تو ذخیره شد.'); }
    catch (error) { notify(error.message); }
  };
  const removeRule = async (id) => { try { await api.deleteAutomationRule(id); await loadRules(); notify('قانون بانکی حذف شد.'); } catch (error) { notify(error.message); } };
  const close = () => applyResult(api.closeReconciliation(detail.id), 'تطبیق این دوره بسته شد.');
  const statusLabels = { unmatched: 'نیازمند بررسی', matched: 'تطبیق‌شده', ignored: 'کنارگذاشته‌شده' };
  return <section className="mt-5 space-y-6">
    <BankVoicePanel accounts={accounts} notify={notify} refresh={refresh} />
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3"><Landmark className="mt-1 shrink-0 text-accent" /><div><h2 className="font-extrabold">ورود صورت‌حساب بانک یا صندوق</h2><p className="mt-1 text-xs leading-6 text-muted">عنوان ستون‌های CSV به‌صورت خودکار نگاشت می‌شود؛ تاریخ شمسی/میلادی و اعداد فارسی پشتیبانی می‌شوند. <a href="/bank-statement-template.csv" download className="font-bold text-accent underline">فایل نمونه</a></p></div></div>
      <form onSubmit={upload} className="mt-4 grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_150px]"><select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="tap rounded-lg border border-line bg-paper px-3">{eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-dashed border-muted/60 bg-paper px-3 text-sm"><input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] || null)} className="sr-only" /><span className="truncate">{file?.name || 'انتخاب فایل CSV'}</span></label><button disabled={busy || !eligibleAccounts.length} className="tap rounded-lg bg-accent font-extrabold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">ورود و بررسی</button></form>
      <p className="mt-2 text-xs text-muted">فایل بانکی فقط روی سرور حساب‌یار پردازش می‌شود و برای OCR یا هوش مصنوعی ارسال نمی‌شود.</p>
    </div>
    {imports.length > 0 && <div><div className="mb-2 flex items-center justify-between"><h2 className="font-extrabold">دوره‌های واردشده</h2><span className="text-xs text-muted">{toPersianDigits(imports.length)} فایل</span></div><div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">{imports.map((item) => <button key={item.id} onClick={() => open(item.id)} className={`min-w-[220px] rounded-xl border p-3 text-right ${detail?.id === item.id ? 'border-accent bg-warn-bg' : 'border-line bg-surface'} hover:bg-paper hover:text-ink`}><span className="block truncate text-sm font-bold">{item.accountName}</span><span className="mt-1 block truncate text-xs text-muted">{item.fileName} · {item.formatName}</span><span className="numbers mt-2 block text-xs">{toPersianDigits(item.matchedCount + item.ignoredCount)} از {toPersianDigits(item.rowCount)} بررسی‌شده</span></button>)}</div></div>}
    {detail && <div className="space-y-4">
      {detail.importWarnings?.length > 0 && <div className="rounded-lg border border-accent/30 bg-warn-bg px-3 py-2 text-xs leading-6 text-muted"><b className="text-ink">نتیجهٔ تشخیص {detail.formatName}:</b> {detail.importWarnings.join(' ')}</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">ردیف‌ها</p><b className="numbers mt-2 block text-lg">{toPersianDigits(detail.rowCount)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">باقی‌مانده</p><b className={`numbers mt-2 block text-lg ${detail.unmatchedCount ? 'text-expense' : 'text-income'}`}>{toPersianDigits(detail.unmatchedCount)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">مانده بانک</p><b className="numbers mt-2 block text-lg">{detail.statementBalance == null ? '—' : formatAmount(detail.statementBalance)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">اختلاف با دفتر</p><b className={`numbers mt-2 block text-lg ${detail.difference === 0 ? 'text-income' : detail.difference == null ? '' : 'text-expense'}`}>{detail.difference == null ? 'نامشخص' : formatAmount(detail.difference)}</b></div></div>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-extrabold">بررسی ردیف‌های {detail.accountName}</h2><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodStart))} تا {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodEnd))}</p></div>{detail.status === 'open' ? <button disabled={busy || !detail.canClose} onClick={close} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-on-fill disabled:opacity-35 hover:bg-ink/90">بستن تطبیق</button> : <span className="rounded-lg border border-income px-3 py-2 text-xs font-bold text-income"><Check size={16} className="ml-1 inline" />تطبیق بسته شده</span>}</div>
      {detail.status === 'open' && detail.blockingReasons?.length > 0 && <div className="rounded-lg border border-expense/25 bg-expense/5 px-3 py-2 text-xs leading-6 text-expense"><b>بستن دوره ممکن نیست:</b> {detail.blockingReasons.join(' ')}</div>}
      <div className="divide-y divide-line border-y border-line">{detail.lines.map((line) => <article key={line.id} className="py-4"><div className="flex items-start gap-3"><div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${line.status === 'matched' ? 'bg-income' : line.status === 'ignored' ? 'bg-muted' : 'bg-accent'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">{line.description || 'بدون شرح بانکی'}</p><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(line.occurredAt))}{line.reference ? ` · پیگیری ${line.reference}` : ''}</p></div><div className="text-left"><b className={`numbers block ${line.direction === 'income' ? 'text-income' : 'text-expense'}`}>{line.direction === 'income' ? '+' : '−'} {formatAmount(line.amount)}</b><span className="mt-1 block text-xs text-muted">{statusLabels[line.status]}</span></div></div>
        {line.status === 'unmatched' && detail.status === 'open' && <div className="mt-3 rounded-lg bg-paper p-3">
          {line.ruleSuggestion && <p className="mb-2 rounded-md bg-accent/10 px-2 py-1.5 text-xs text-accent">قانون «{line.ruleSuggestion.pattern}» دستهٔ {line.ruleSuggestion.category} را پیشنهاد می‌دهد.</p>}
          {line.candidates.length > 0 && <div><p className="text-xs font-bold text-muted">پیشنهاد تطبیق با دلیل</p><div className="mt-2 grid gap-2">{line.candidates.map((candidate) => <button disabled={busy} key={candidate.id} onClick={() => match(line.id, candidate.id)} className="tap rounded-lg border border-income bg-surface px-3 py-2 text-right text-xs"><b className="text-income">تطبیق {toPersianDigits(candidate.score)}٪</b><span className="mr-2 text-muted">{candidate.category} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(candidate.occurredAt))}</span><span className="mt-1 block text-xs leading-5 text-muted">{candidate.reasons.join(' ')}</span></button>)}</div></div>}
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_100px_100px]"><select value={lineCategories[line.id] || line.ruleSuggestion?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')} onChange={(event) => setLineCategories({ ...lineCategories, [line.id]: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-3 text-sm">{categories.filter((category) => category.type === line.direction).map((category) => <option key={category.id}>{category.name}</option>)}</select><button disabled={busy} onClick={() => create(line)} className="tap rounded-lg bg-accent px-3 text-xs font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">ثبت در دفتر</button><button disabled={busy || !line.description} onClick={() => learn(line)} className="tap rounded-lg border border-accent px-3 text-xs font-bold text-accent">ساخت قانون</button><button disabled={busy} onClick={() => ignore(line)} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted hover:bg-paper hover:text-ink">کنارگذاری</button></div>
        </div>}{line.resolutionNote && <p className="mt-2 text-xs text-muted">{line.resolutionNote}</p>}</div></div></article>)}</div>
    </div>}
    {rules.length > 0 && <div className="rounded-xl border border-line bg-surface p-4"><h3 className="font-extrabold">قواعد تأییدشدهٔ بانکی</h3><div className="mt-2 flex flex-wrap gap-2">{rules.map((rule) => <span key={rule.id} className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5 text-xs">{rule.pattern} ← {rule.category}<button onClick={() => removeRule(rule.id)} aria-label={`حذف قانون ${rule.pattern}`} className="text-expense"><X size={14} /></button></span>)}</div></div>}
    {!imports.length && !detail && <p className="py-8 text-center text-sm text-muted">هنوز صورت‌حسابی وارد نشده است.</p>}
  </section>;
}
