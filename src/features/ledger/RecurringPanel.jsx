// برگهٔ «دوره‌ای»: ثبت‌های تکرارشونده.
//
// از src/features/ledger/LedgerPage.jsx جدا شد؛ بدنهٔ کامپوننت‌ها دست نخورده است.

import { RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

export function RecurringPanel({ categories, notify }) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState({ title: '', amount: '', type: 'expense', category: 'اجاره', dayOfMonth: 1 });
  const load = useCallback(() => api.recurring().then((result) => setItems(result.items)), []);
  useEffect(() => { load(); }, [load]);
  const save = async (event) => { event.preventDefault(); await api.saveRecurring(draft); setDraft({ ...draft, title: '', amount: '' }); notify('ثبت دوره‌ای فعال شد.'); load(); };
  const remove = async (id) => { await api.deleteRecurring(id); notify('ثبت دوره‌ای حذف شد.'); load(); };
  return <section className="mt-5 space-y-5"><p className="text-sm leading-7 text-muted">حقوق، اجاره، قسط و درآمدهای ثابت را یک‌بار تعریف کن؛ در سررسید خودکار وارد دفتر می‌شوند.</p><form onSubmit={save} className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2"><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="مثلاً اجاره مغازه" className="tap rounded-lg border border-line px-3" /><input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ تومان" className="tap numbers rounded-lg border border-line px-3" /><select value={draft.type} onChange={(event) => { const type = event.target.value; setDraft({ ...draft, type, category: categories.find((item) => item.type === type)?.name || '' }); }} className="tap rounded-lg border border-line px-3"><option value="expense">هزینه</option><option value="income">درآمد</option></select><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap rounded-lg border border-line px-3">{categories.filter((item) => item.type === draft.type).map((item) => <option key={item.id}>{item.name}</option>)}</select><label className="flex items-center gap-2 text-xs text-muted">روز ماه<input type="number" min="1" max="31" value={draft.dayOfMonth} onChange={(event) => setDraft({ ...draft, dayOfMonth: event.target.value })} className="tap numbers w-20 rounded-lg border border-line px-2" /></label><button className="tap rounded-lg bg-accent font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">فعال‌سازی</button></form><div className="divide-y divide-line border-y border-line">{items.map((item) => <article key={item.id} className="flex min-h-[72px] items-center gap-3 py-3"><RotateCcw size={19} className="text-muted" /><div className="min-w-0 flex-1"><p className="font-bold">{item.title}</p><p className="mt-1 text-xs text-muted">روز {toPersianDigits(item.dayOfMonth)} هر ماه · {item.category}</p></div><b className={`numbers text-sm ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatAmount(item.amount)}</b><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense"><Trash2 size={17} /></button></article>)}</div></section>;
}
