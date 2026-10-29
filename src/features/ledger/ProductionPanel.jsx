// تولید: ثبت تولید تازه (مواد به میانگین موزون بیرون، محصول با همان ارزش درون)، تاریخچهٔ
// تولیدهای حساب‌یار، و فرمول و تاریخچهٔ تولیدِ بکاپ پارسیان که فقط خواندنی است.

import { Factory } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { PersianDateInput } from '../../components/common.jsx';
import { formatAmount, persianDate, toPersianDigits, unitLabel } from '../../lib/format.js';

const quantityText = (value) => toPersianDigits(Math.round(Number(value) * 1000) / 1000);

export function ProductionPanel({ products = [], notify, onChange }) {
  const [data, setData] = useState({ runs: [], parsian: { formulas: [], runs: [], totals: {} } });
  const [draft, setDraft] = useState({ productId: '', quantity: '', occurredAt: '', note: '' });
  const [components, setComponents] = useState([]);
  const [planNote, setPlanNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [openFormula, setOpenFormula] = useState('');
  const tracked = products.filter((product) => product.trackInventory !== 0);

  const load = useCallback(() => api.production().then(setData).catch((error) => notify(error.message)), [notify]);
  useEffect(() => { load(); }, [load]);

  // اجزای پیشنهادی از فرمول؛ هر بار که محصول یا تعداد عوض شود.
  useEffect(() => {
    if (!draft.productId) { setComponents([]); setPlanNote(''); return undefined; }
    let alive = true;
    api.productionPlan(draft.productId, Number(draft.quantity) || 1).then((plan) => {
      if (!alive) return;
      setComponents(plan.components.filter((item) => item.productId).map((item) => ({ productId: item.productId, quantity: String(item.quantity), stock: item.stock, unit: item.unit })));
      const missing = plan.components.filter((item) => !item.productId).length;
      setPlanNote(plan.fromFormula
        ? `اجزا از فرمول تولید پارسیان پیشنهاد شد${missing ? `؛ ${toPersianDigits(missing)} جزء فرمول در انبار نیست` : ''}. مقدار واقعی مصرف را اگر فرق داشت عوض کن.`
        : 'این کالا فرمول تولید ندارد؛ مواد مصرف‌شده را خودت اضافه کن.');
    }).catch((error) => notify(error.message));
    return () => { alive = false; };
  }, [draft.productId, draft.quantity, notify]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { item } = await api.recordProduction({
        productId: draft.productId, quantity: Number(draft.quantity), occurredAt: draft.occurredAt || undefined, note: draft.note,
        components: components.map((item) => ({ productId: item.productId, quantity: Number(item.quantity) })),
      });
      notify(`تولید ثبت شد: بهای هر واحد ${formatAmount(item.unitCost)} ${unitLabel()}، سند ${toPersianDigits(item.documentNumber ?? '')}.`);
      setDraft({ productId: '', quantity: '', occurredAt: '', note: '' });
      await load(); await onChange?.();
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const field = 'tap rounded-lg border border-line bg-paper px-3 text-[13px]';
  const parsian = data.parsian || { formulas: [], runs: [], totals: {} };
  return <div className="space-y-4">
    <form onSubmit={submit} className="space-y-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-2"><Factory size={20} className="mt-0.5 text-accent" /><div>
        <h3 className="font-extrabold">ثبت تولید</h3>
        <p className="mt-1 text-xs leading-5 text-muted">مواد به بهای میانگین موزون از انبار کم می‌شوند و محصول با همان ارزش وارد می‌شود. پول جابه‌جا نمی‌شود و درآمد یا هزینه‌ای ساخته نمی‌شود؛ دستمزد و سربار را اگر باید جذب شوند، حسابدار جدا ثبت می‌کند.</p>
      </div></div>
      <div className="grid gap-2 sm:grid-cols-2">
        <select required value={draft.productId} onChange={(event) => setDraft({ ...draft, productId: event.target.value })} className={field} aria-label="محصول">
          <option value="">چه چیزی تولید شد؟</option>
          {tracked.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </select>
        <input required inputMode="decimal" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value.replace(/[^\d.]/g, '') })} placeholder="تعداد تولید" className={`${field} numbers`} />
        <label className="text-xs text-muted">تاریخ<PersianDateInput direction="past" aria-label="تاریخ تولید" value={draft.occurredAt} onChange={(iso) => setDraft({ ...draft, occurredAt: iso })} /></label>
        <input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="شرح (اختیاری)" className={field} />
      </div>
      {planNote && <p className="text-xs leading-5 text-muted">{planNote}</p>}
      {draft.productId && <div className="space-y-1.5">
        {components.map((item, index) => {
          const short = Number(item.quantity) > Number(item.stock ?? Infinity);
          return <div key={index} className="flex flex-wrap items-center gap-2">
            <select value={item.productId} onChange={(event) => {
              const chosen = tracked.find((product) => product.id === event.target.value);
              setComponents(components.map((row, at) => (at === index ? { ...row, productId: event.target.value, stock: chosen?.stock, unit: chosen?.unit } : row)));
            }} className={`${field} min-w-0 flex-1`} aria-label="جزء مصرفی">
              {tracked.filter((product) => product.id !== draft.productId).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
            <input inputMode="decimal" value={item.quantity} onChange={(event) => setComponents(components.map((row, at) => (at === index ? { ...row, quantity: event.target.value.replace(/[^\d.]/g, '') } : row)))}
              className={`${field} numbers w-28`} aria-label="مقدار مصرف" />
            <span className={`text-xs ${short ? 'font-bold text-expense' : 'text-muted'}`}>موجودی {quantityText(item.stock ?? 0)} {item.unit}</span>
            <button type="button" onClick={() => setComponents(components.filter((_, at) => at !== index))} className="tap rounded-lg px-2 text-xs text-muted hover:text-expense">حذف</button>
          </div>;
        })}
        <button type="button" onClick={() => {
          const first = tracked.find((product) => product.id !== draft.productId);
          if (first) setComponents([...components, { productId: first.id, quantity: '', stock: first.stock, unit: first.unit }]);
        }} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted hover:text-ink">افزودن جزء</button>
      </div>}
      <button disabled={busy || !draft.productId || !(Number(draft.quantity) > 0) || !components.some((item) => Number(item.quantity) > 0)}
        className="tap w-full rounded-lg bg-accent font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90">{busy ? 'در حال ثبت…' : 'ثبت تولید'}</button>
    </form>

    {data.runs.length > 0 && <div>
      <h3 className="mb-2 font-extrabold">تولیدهای ثبت‌شده</h3>
      <div className="divide-y divide-line border-y border-line">{data.runs.map((run) => <article key={run.id} className="py-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-2"><b>{quantityText(run.quantity)} {run.unit} {run.productName}</b>
          <span className="text-xs text-muted">{persianDate(run.occurredAt)}{run.documentNumber ? ` · سند ${toPersianDigits(run.documentNumber)}` : ''}</span>
          <b className="numbers mr-auto">{formatAmount(run.value)}</b></div>
        <p className="mt-1 text-xs leading-5 text-muted">مصرف: {run.components.map((item) => `${item.name} ${quantityText(item.quantity)} ${item.unit}`).join('، ')}</p>
      </article>)}</div>
    </div>}

    {(parsian.formulas.length > 0 || parsian.runs.length > 0) && <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div><h3 className="font-extrabold">فرمول و تاریخچهٔ تولید پارسیان</h3>
        <p className="mt-1 text-xs leading-5 text-muted">از بکاپ، فقط برای خواندن. {toPersianDigits(parsian.formulas.length)} فرمول، {toPersianDigits(parsian.totals.production || 0)} فاکتور تولید و {toPersianDigits(parsian.totals.consumption || 0)} فاکتور مصرف. ارزش تولید را خود پارسیان گذاشته و اگر با بهای مصرف همان تولید نخواند، فاصله‌اش نشان داده می‌شود.</p></div>
      {parsian.formulas.length > 0 && <div className="divide-y divide-line border-y border-line">{parsian.formulas.map((formula) => <div key={formula.productCode} className="py-2 text-sm">
        <button type="button" onClick={() => setOpenFormula(openFormula === formula.productCode ? '' : formula.productCode)} className="flex w-full items-baseline gap-2 text-right">
          <b className="min-w-0 flex-1 truncate">{formula.productName}</b>
          <span className="text-xs text-muted">{toPersianDigits(formula.components.length)} جزء</span>
          {formula.priced && <span className="numbers text-xs text-muted">بهای فرمول هر واحد {formatAmount(Math.round(formula.unitCost))}</span>}
        </button>
        {openFormula === formula.productCode && <ul className="mt-1 space-y-0.5 pr-3 text-xs leading-5 text-muted">
          {formula.components.map((item) => <li key={item.code}>• {item.name}: {quantityText(item.perUnit)} {item.unit} برای هر واحد</li>)}
        </ul>}
      </div>)}</div>}
      {parsian.runs.length > 0 && <div className="divide-y divide-line border-y border-line">{parsian.runs.slice(0, 40).map((run) => <article key={`${run.number}:${run.jalaliDate}`} className="py-2 text-xs leading-5">
        <div className="flex flex-wrap items-baseline gap-2"><b className="text-sm">تولید {toPersianDigits(run.number)}</b><span className="text-muted">{toPersianDigits(run.jalaliDate)}</span>
          <span className="numbers mr-auto">{formatAmount(run.outputValue)}</span></div>
        <p className="text-muted">{run.outputs.map((line) => `${line.title} ${quantityText(line.quantity)} ${line.unit}`).join('، ')}</p>
        {run.consumption ? <p className="text-muted">مصرف (فاکتور {toPersianDigits(run.consumption.number)}): {toPersianDigits(run.consumption.lines.length)} قلم، {formatAmount(run.inputValue)}
          {run.gap ? <b className={run.gap > 0 ? 'text-warn' : 'text-expense'}> · فاصله {formatAmount(run.gap)}</b> : null}</p>
          : <p className="text-warn">فاکتور مصرف این تولید در بکاپ نیست.</p>}
      </article>)}</div>}
    </div>}
  </div>;
}
