import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export function LearningPage({ categories, notify }) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState({ keyword: '', category: 'خوراک' });
  const load = () => api.learnings().then((result) => setItems(result.items));
  // load یک Promise برمی‌گرداند؛ اگر مستقیم به useEffect داده شود، React همان را
  // تابع پاک‌سازی می‌پندارد و هنگام ترک صفحه صدایش می‌زند. نتیجه‌اش از کار افتادن
  // کل برنامه به محض رفتن از «یادگیری‌ها» به هر صفحهٔ دیگر بود.
  useEffect(() => { load(); }, []);
  const save = async () => { if (!draft.keyword.trim()) return; await api.saveLearning(draft); setDraft({ ...draft, keyword: '' }); notify('یادگیری تازه ذخیره شد.'); load(); };
  const update = async (item, category) => { await api.updateLearning(item.id, { keyword: item.keyword, category }); load(); };
  const remove = async (id) => { await api.deleteLearning(id); notify('این یادگیری حذف شد.'); load(); };
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">آنچه یاد گرفته‌ام</h1><p className="mt-2 text-sm leading-7 text-muted">فقط نگاشت‌هایی اینجا می‌مانند که خودت صریحاً تأیید کرده‌ای یا دستی ساخته‌ای. هر مورد را هر زمان بخواهی می‌توانی تغییر بدهی یا پاک کنی.</p><div className="mt-5 flex gap-2 rounded-[10px] border border-line bg-surface p-2"><input value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} placeholder="مثلاً اسنپ‌فود" className="tap min-w-0 flex-1 px-2 outline-none" /><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap max-w-32 rounded-lg border border-line px-2">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={save} className="tap grid place-items-center rounded-lg bg-accent text-on-fill" aria-label="افزودن"><Plus size={21} /></button></div><div className="mt-5 divide-y divide-line border-y border-line">{items.length ? items.map((item) => <div key={item.id} className="flex min-h-[64px] items-center gap-2"><span className="min-w-0 flex-1 truncate font-bold">{item.keyword}</span><ChevronLeft size={17} className="text-muted" /><select value={item.category} onChange={(event) => update(item, event.target.value)} className="tap max-w-36 bg-transparent text-sm text-muted outline-none">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense" aria-label={`حذف ${item.keyword}`}><Trash2 size={18} /></button></div>) : <p className="py-10 text-center text-sm text-muted">هنوز نگاشت تأییدشده‌ای ندارم.</p>}</div></main>;
}
