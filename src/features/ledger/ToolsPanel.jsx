// برگهٔ «ابزارها»: پرسش از دفتر، ورود هوشمند رسید و بازبینی آن، و بستن صندوق امروز.
//
// از src/features/ledger/LedgerPage.jsx جدا شد؛ بدنهٔ کامپوننت‌ها دست نخورده است.

import { Check, Mic, ReceiptText, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PRODUCT_POSITIONING } from '../../../shared/product.js';
import { api } from '../../lib/api.js';
import { createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported } from '../../lib/liveSpeech.js';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

const RECEIPT_STATUS = {
  failed: ['OCR ناموفق', 'text-expense'], review: ['نیازمند بازبینی', 'text-expense'], ready: ['آمادهٔ تأیید', 'text-accent'],
  linked: ['ثبت و متصل‌شده', 'text-income'], pending: ['در حال بررسی', 'text-muted'], ignored: ['کنارگذاشته‌شده', 'text-muted'],
};

function ReceiptReviewPanel({ detail, candidates, accounts, categories, notify, onChanged, refresh }) {
  const [draft, setDraft] = useState(detail);
  const [busy, setBusy] = useState(false);
  const [learnMerchant, setLearnMerchant] = useState(false);
  useEffect(() => { setDraft(detail); setLearnMerchant(false); }, [detail]);
  const save = async () => {
    setBusy(true);
    try { const result = await api.updateReceipt(detail.id, draft); onChanged(result.item, result.candidates); notify('اصلاحات رسید ذخیره شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const confirm = async (link = {}) => {
    setBusy(true);
    try {
      const result = await api.confirmReceipt(detail.id, { ...draft, ...link });
      if (learnMerchant && draft.merchant?.trim()) await api.saveAutomationRule({ source: 'merchant', pattern: draft.merchant, type: draft.type, category: draft.category, accountId: draft.accountId });
      onChanged(result.item, { transactions: [], statementLines: [] }); refresh();
      notify(link.transactionId ? 'رسید به ثبت موجود متصل شد.' : link.statementLineId ? 'رسید، ردیف بانک و ثبت دفتر به هم متصل شدند.' : 'رسید تأیید و در دفتر ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const canConfirm = draft.amount && draft.type && draft.category && draft.accountId && detail.status !== 'linked';
  const confidence = Math.round(Number(detail.ocrConfidence || 0) * 100);
  return <div className="rounded-xl border border-accent/35 bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-extrabold">بازبینی رسید</h3><p className="mt-1 text-xs text-muted">پیشنهاد OCR هیچ‌وقت بدون تأیید تو وارد دفتر نمی‌شود.</p></div><a href={api.workspacePath(`/api/receipts/${detail.id}/image`)} target="_blank" rel="noreferrer" className="tap rounded-lg border border-line px-3 text-xs font-bold hover:bg-paper hover:text-ink">دیدن تصویر اصلی</a></div>
    {detail.ocrProvider && <div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-md bg-paper px-2 py-1">مسیر: {detail.ocrProvider === 'openai' ? 'OCR تصویر' : 'توضیح کاربر'}</span><span className={`rounded-md bg-paper px-2 py-1 ${confidence >= 72 ? 'text-income' : 'text-expense'}`}>اطمینان کلی: {toPersianDigits(confidence)}٪</span>{detail.fieldConfidence?.amount != null && <span className="rounded-md bg-paper px-2 py-1">اطمینان مبلغ: {toPersianDigits(Math.round(detail.fieldConfidence.amount * 100))}٪</span>}</div>}
    {detail.reviewReasons?.length > 0 && <div className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-expense">{detail.reviewReasons.map((reason) => <p key={reason}>• {reason}</p>)}</div>}
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      <label className="text-xs text-muted">مبلغ کل؛ {unitLabel()}<input inputMode="numeric" value={draft.amount || ''} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">فروشنده<input value={draft.merchant || ''} onChange={(event) => setDraft({ ...draft, merchant: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">نوع<select value={draft.type || 'expense'} onChange={(event) => setDraft({ ...draft, type: event.target.value, category: categories.find((item) => item.type === event.target.value)?.name || '' })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-ink"><option value="expense">هزینه</option><option value="income">درآمد</option></select></label>
      <label className="text-xs text-muted">دسته<select value={draft.category || ''} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-ink"><option value="">انتخاب دسته</option>{categories.filter((item) => item.type === (draft.type || 'expense')).map((item) => <option key={item.id}>{item.name}</option>)}</select></label>
      <label className="text-xs text-muted">حساب<select value={draft.accountId || 'cash'} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-ink">{accounts.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="text-xs text-muted">روش تسویه<input value={draft.paymentMethod || ''} onChange={(event) => setDraft({ ...draft, paymentMethod: event.target.value })} placeholder="کارت، نقد، انتقال…" className="tap mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">تاریخ رسید<input type="date" value={(draft.occurredAt || '').slice(0, 10)} onChange={(event) => setDraft({ ...draft, occurredAt: event.target.value })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">شماره پیگیری<input value={draft.reference || ''} onChange={(event) => setDraft({ ...draft, reference: event.target.value })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted sm:col-span-2">توضیح تکمیلی<input value={draft.note || ''} onChange={(event) => setDraft({ ...draft, note: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
    </div>
    {detail.status !== 'linked' && <label className="mt-3 flex items-start gap-2 text-xs leading-6 text-muted"><input type="checkbox" checked={learnMerchant} disabled={!draft.merchant} onChange={(event) => setLearnMerchant(event.target.checked)} className="mt-1" />با تأیید من، برای رسیدهای بعدی این فروشنده دسته و حساب فعلی را پیشنهاد بده.</label>}
    {detail.status !== 'linked' && <div className="mt-4 flex flex-wrap gap-2"><button disabled={busy} onClick={save} className="tap rounded-lg border border-line px-4 text-xs font-bold hover:bg-paper hover:text-ink">فقط ذخیره اصلاحات</button><button disabled={busy || !canConfirm} onClick={() => confirm()} className="tap rounded-lg bg-accent px-4 text-xs font-bold text-on-fill disabled:opacity-35 hover:bg-accent/90 active:bg-accent/80">تأیید و ساخت ثبت</button></div>}
    {detail.status !== 'linked' && (candidates.transactions?.length > 0 || candidates.statementLines?.length > 0) && <div className="mt-4 border-t border-line pt-3"><p className="text-xs font-bold">یا اتصال به مورد موجود</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{candidates.transactions?.map((item) => <button key={item.id} disabled={busy} onClick={() => confirm({ transactionId: item.id, accountId: item.accountId })} className="tap rounded-lg border border-income px-3 py-2 text-right text-xs"><b className="text-income">ثبت دفتر · {toPersianDigits(item.score)}٪</b><span className="mt-1 block text-muted">{item.category} · {item.reasons.join(' ')}</span></button>)}{candidates.statementLines?.map((item) => <button key={item.id} disabled={busy} onClick={() => confirm({ statementLineId: item.id, accountId: item.accountId })} className="tap rounded-lg border border-accent px-3 py-2 text-right text-xs"><b className="text-accent">ردیف بانک · {toPersianDigits(item.score)}٪</b><span className="mt-1 block text-muted">{item.accountName} · {item.reasons.join(' ')}</span></button>)}</div></div>}
    {detail.status === 'linked' && <p className="mt-4 rounded-lg bg-income/10 px-3 py-2 text-xs font-bold text-income"><Check size={16} className="ml-1 inline" />این رسید به ثبت دفتر متصل شده است.</p>}
  </div>;
}

function FinancialAnswerCard({ answer }) {
  const [selectedSource, setSelectedSource] = useState(null);
  useEffect(() => setSelectedSource(null), [answer]);
  const kindLabel = { transaction: 'ثبت دفتر', obligation: 'طلب/بدهی', invoice: 'سند', account: 'حساب' };
  const sourceDate = selectedSource?.occurredAt || selectedSource?.dueAt || selectedSource?.createdAt;
  const dateLabel = sourceDate ? new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(sourceDate)) : '';
  const scopeDate = (value) => value ? new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value)) : '';
  const scopeRange = answer.scope ? [scopeDate(answer.scope.from), scopeDate(answer.scope.to)].filter(Boolean).join(' تا ') : '';
  return <div className="mt-3 rounded-xl border border-accent/25 bg-warn-bg p-3">
    <p className="text-sm font-bold leading-7">{toPersianDigits(answer.answer)}</p>
    {answer.scope && <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-bold text-muted"><span className="rounded-full bg-surface px-2 py-1">بازه: {toPersianDigits(answer.scope.label)}</span>{scopeRange && <span className="rounded-full bg-surface px-2 py-1">{toPersianDigits(scopeRange)}</span>}<span className="rounded-full bg-surface px-2 py-1">واحد: {answer.scope.unit}</span><span className="rounded-full bg-surface px-2 py-1">{answer.scope.basisLabel}</span></div>}
    <details className="mt-3 border-t border-accent/15 pt-2"><summary className="cursor-pointer text-xs font-extrabold">عدد از کجا آمده؟</summary><p className="mt-2 text-xs leading-5 text-muted">{answer.provenance?.calculation || 'محاسبه مستقیم از داده‌های دفتر'}</p><p className="mt-1 text-xs text-muted">{toPersianDigits(answer.provenance?.sourceCount || 0)} منبع سازندهٔ پاسخ</p>
      {answer.sources?.length ? <div className="scrollbar-none mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">{answer.sources.map((source) => <button type="button" key={`${source.kind}-${source.id}-${source.period || ''}`} onClick={() => setSelectedSource(source)} className={`rounded-md border px-2 py-1 text-xs font-bold ${selectedSource?.id === source.id && selectedSource?.period === source.period ? 'border-accent bg-surface text-accent' : 'border-line bg-surface text-muted'} hover:bg-paper hover:text-ink`}>{kindLabel[source.kind] || 'منبع'} · {source.label}</button>)}</div> : <p className="mt-2 rounded-md bg-surface px-2 py-1.5 text-xs text-muted">هیچ ثبت سازنده‌ای در این محدوده پیدا نشد؛ مقدار صفر از نبودِ ثبت به‌دست آمده است.</p>}
      {selectedSource && <div className="mt-2 rounded-lg border border-line bg-surface p-2 text-xs leading-5"><div className="flex items-center justify-between gap-2"><b>{selectedSource.label}</b><span className="numbers text-muted">{selectedSource.amount != null ? `${formatAmount(selectedSource.amount)} ${unitLabel()}` : ''}</span></div><p className="mt-1 text-muted">{kindLabel[selectedSource.kind] || 'منبع'}{selectedSource.category ? ` · ${selectedSource.category}` : ''}{selectedSource.contactName ? ` · ${selectedSource.contactName}` : ''}{dateLabel ? ` · ${dateLabel}` : ''}{selectedSource.period === 'previous' || selectedSource.period === 'baseline' ? ' · خط مبنا' : ''}</p><p className="mt-1 select-all font-mono text-xs text-muted">شناسه: {selectedSource.id}</p></div>}
    </details>
    <p className="mt-3 border-t border-accent/15 pt-2 text-xs leading-5 text-muted">{answer.disclaimer}</p>
  </div>;
}

export function ToolsPanel({ profileType = 'business', accounts = [], categories = [], notify, refresh }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [countedCash, setCountedCash] = useState('');
  const [closing, setClosing] = useState(null);
  const [receiptFile, setReceiptFile] = useState(null);
  const [receiptNote, setReceiptNote] = useState('');
  const [receiptAccountId, setReceiptAccountId] = useState(accounts.find((item) => item.active)?.id || 'cash');
  const [receipts, setReceipts] = useState([]);
  const [ocrConfigured, setOcrConfigured] = useState(true);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [receiptMatches, setReceiptMatches] = useState({ transactions: [], statementLines: [] });
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
  const recognizerRef = useRef(null);
  const fileInputRef = useRef(null);
  const loadReceipts = useCallback(async () => { const result = await api.receipts(); setReceipts(result.items); setOcrConfigured(result.ocrConfigured); }, []);
  useEffect(() => { loadReceipts().catch(() => {}); return () => recognizerRef.current?.stop?.(); }, [loadReceipts]);
  const ask = async (event) => { event.preventDefault(); if (!question.trim()) return; try { setAnswer(await api.ask(question)); } catch (error) { notify(error.message); } };
  const close = async (event) => { event.preventDefault(); const result = await api.closeDay({ countedCash }); setClosing(result.item); notify('بستن صندوق ذخیره شد.'); };
  const openReceipt = async (id) => { try { const result = await api.receipt(id); setSelectedReceipt(result.item); setReceiptMatches(result.candidates); } catch (error) { notify(error.message); } };
  const updateSelected = async (item, matches) => { setSelectedReceipt(item); setReceiptMatches(matches); await loadReceipts(); };
  const toggleDictation = () => {
    if (dictating) { recognizerRef.current?.stop(); setDictating(false); return; }
    if (!liveSpeechSupported()) return notify('تایپ زنده فارسی در این مرورگر فعال نیست؛ توضیح را دستی بنویس.');
    const recognizer = createPersianRecognizer({ onUpdate: (snapshot) => setReceiptNote(snapshot.transcript), onEnd: () => setDictating(false), onError: (code) => { setDictating(false); notify(liveSpeechErrorMessage(code)); } });
    recognizerRef.current = recognizer;
    try { recognizer.start(); setDictating(true); } catch { notify('میکروفن توضیح رسید شروع نشد.'); }
  };
  const saveReceiptFile = async (event) => {
    event.preventDefault();
    if (!receiptFile) return notify('اول عکس رسید را انتخاب کن.');
    setReceiptBusy(true);
    try {
      const result = await api.saveReceipt(receiptFile, receiptNote, receiptAccountId);
      setReceiptFile(null); setReceiptNote(''); if (fileInputRef.current) fileInputRef.current.value = '';
      setSelectedReceipt(result.item); setReceiptMatches(result.candidates); await loadReceipts();
      notify(result.warning ? result.warning.message : 'رسید خوانده شد؛ پیشنهادها را قبل از ثبت کنترل کن.');
    } catch (error) { notify(error.message); }
    finally { setReceiptBusy(false); }
  };
  return <section className="mt-5 space-y-6">
    <div className="rounded-xl border border-line bg-surface p-4"><div className="flex items-center gap-2"><Sparkles size={19} className="text-accent" /><h2 className="font-extrabold">از دفترت بپرس</h2></div><p className="mt-2 text-xs leading-6 text-muted">پاسخ فقط از داده‌های ثبت‌شده ساخته می‌شود؛ هیچ عددی حدس زده نمی‌شود. می‌توانی آخرین پرداخت، جمع یک دسته، ماندهٔ یک شخص یا مقایسهٔ دو بازه را بپرسی.</p><form onSubmit={ask} className="mt-3 flex gap-2"><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="مثلاً خوراک این ماه چقدر شد؟" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-ink px-4 font-bold text-on-fill hover:bg-ink/90">بپرس</button></form>{answer && <FinancialAnswerCard answer={answer} />}</div>
    <form onSubmit={saveReceiptFile} className="rounded-xl border border-line bg-surface p-4"><div className="flex items-center gap-2"><ReceiptText size={20} className="text-accent" /><h2 className="font-extrabold">ورود هوشمند رسید</h2></div><p className="mt-2 text-xs leading-6 text-muted">مبلغ، تاریخ و فروشنده از تصویر پیشنهاد می‌شود. توضیح صوتی برای دسته، حساب و روش تسویه به پیشنهاد اضافه می‌شود.</p>{!ocrConfigured && <p className="mt-2 rounded-lg bg-warn-bg px-3 py-2 text-xs text-expense">OPENAI_API_KEY برای OCR تنظیم نیست؛ عکس از بین نمی‌رود و با توضیح تو وارد صندوق بازبینی می‌شود.</p>}<input ref={fileInputRef} required type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => setReceiptFile(event.target.files?.[0] || null)} className="mt-3 block w-full text-xs" /><div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]"><div className="flex gap-2"><input value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} placeholder="مثلاً مواد خریدم، با کارت بانک ملت" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button type="button" onClick={toggleDictation} className={`tap grid place-items-center rounded-lg border px-3 ${dictating ? 'border-expense bg-expense/10 text-expense' : 'border-line text-accent'}`} aria-label={dictating ? 'توقف توضیح صوتی' : 'توضیح صوتی'}><Mic size={19} /></button></div><select value={receiptAccountId} onChange={(event) => setReceiptAccountId(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm">{accounts.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><button disabled={receiptBusy} className="tap mt-3 w-full rounded-lg bg-accent font-bold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">{receiptBusy ? 'در حال خواندن و تحلیل…' : 'خواندن رسید و افزودن به صندوق'}</button>
      {receipts.length > 0 && <div className="mt-4 border-t border-line pt-3"><div className="flex items-center justify-between"><h3 className="text-sm font-extrabold">صندوق رسیدها</h3><span className="text-xs text-muted">{toPersianDigits(receipts.filter((item) => item.status !== 'linked').length)} مورد باز</span></div><div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto pb-1">{receipts.slice(0, 20).map((item) => { const status = RECEIPT_STATUS[item.status] || RECEIPT_STATUS.review; return <button type="button" key={item.id} onClick={() => openReceipt(item.id)} className={`min-w-[180px] rounded-lg border p-3 text-right ${selectedReceipt?.id === item.id ? 'border-accent bg-warn-bg' : 'border-line bg-paper'} hover:bg-paper hover:text-ink`}><span className="block truncate text-xs font-bold">{item.merchant || item.fileName}</span><span className="numbers mt-1 block text-sm">{item.amount ? `${formatAmount(item.amount)} ${unitLabel()}` : 'مبلغ نامشخص'}</span><span className={`mt-1 block text-xs ${status[1]}`}>{status[0]}</span></button>; })}</div></div>}
    </form>
    {selectedReceipt && <ReceiptReviewPanel detail={selectedReceipt} candidates={receiptMatches} accounts={accounts} categories={categories} notify={notify} onChanged={updateSelected} refresh={refresh} />}
    {profileType === 'business' && <form onSubmit={close} className="rounded-xl border border-line bg-surface p-4"><h2 className="font-extrabold">بستن صندوق امروز</h2><p className="mt-2 text-xs leading-6 text-muted">پول واقعی صندوق را وارد کن تا اختلافش با ثبت‌های امروز مشخص شود.</p><div className="mt-3 flex gap-2"><input required inputMode="numeric" value={countedCash} onChange={(event) => setCountedCash(event.target.value.replace(/\D/g, ''))} placeholder="موجودی شمارش‌شده" className="tap numbers min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-accent px-4 font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">محاسبه</button></div>{closing && <p className={`numbers mt-3 rounded-lg px-3 py-2 text-sm font-bold ${closing.difference === 0 ? 'bg-income/10 text-income' : 'bg-warn-bg text-expense'}`}>اختلاف: {formatAmount(closing.difference)} {unitLabel()}</p>}</form>}
    <div className="rounded-xl border border-line bg-surface p-4"><p className="text-sm font-bold">محدوده فعلی حساب‌یار</p><p className="mt-2 text-xs leading-6 text-muted">{PRODUCT_POSITIONING.accountingDisclaimer}</p></div>
  </section>;
}
