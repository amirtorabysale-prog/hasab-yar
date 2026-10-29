import { ChevronLeft, Download, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { HistoryLessons } from './HistoryLessons.jsx';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

const SOURCE_LABELS = { ai: 'از AI', accountant: 'از تأیید حسابدار', topic: 'از ارتقای موضوع', history: 'از سابقهٔ دفتر' };
const DECIDERS = ['owner', 'manager', 'accountant'];
const POLICY_SETTERS = ['owner', 'manager'];

/** آنچه واقعاً ثبت شد، به زبان ثبت‌کننده. */
function finalLabel(final = {}) {
  if (final.kind === 'obligation') return 'تعهدِ پرداخت‌نشده';
  if (final.kind === 'transfer') return 'انتقال بین حساب‌های خود شرکت';
  if (final.kind === 'settlement') return 'تسویهٔ طلب یا بدهی';
  if (final.kind === 'partner-settlement') return 'تسویه از پول شخصی شریک';
  const side = final.type === 'income' ? 'دریافت' : 'پرداخت';
  return final.category ? `${side} — ${final.category}` : side;
}

function parserLabel(lesson) {
  const rows = lesson.parser?.rows || [];
  if (!rows.length) return '';
  return rows.map((row) => `${row.type === 'income' ? 'دریافت' : 'پرداخت'} ${formatAmount(row.amount)} — ${row.category}`).join('، ');
}

function CategoryLesson({ lesson, threshold, canDecide, busy, decide }) {
  const conflict = lesson.status === 'conflict';
  return <li className="py-3">
    <p className="flex flex-wrap items-center gap-1.5 font-bold"><span>«{lesson.keyword}»</span><ChevronLeft size={16} className="text-muted" aria-hidden="true" /><span className="text-accent">{lesson.category}</span></p>
    <p className="mt-1 text-xs leading-6 text-muted">پارسر می‌گفت «{lesson.parserCategory}» · {toPersianDigits(Math.min(lesson.confirmations, threshold))} از {toPersianDigits(threshold)} تأیید</p>
    <p className="mt-1 line-clamp-2 text-sm leading-6">{lesson.sample}</p>
    {conflict && <p className="mt-1 text-xs leading-6 text-warn">برای همین واژه یادگیری دیگری داری؛ خودکار عوض نمی‌شود.</p>}
    {canDecide && <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => decide(lesson, conflict ? 'replace' : 'learn')} className="tap rounded-lg bg-accent px-3 text-sm font-bold text-on-fill hover:bg-accent/90 disabled:opacity-60">{conflict ? 'جایگزین کن' : 'یاد بگیر'}</button>
      <button type="button" disabled={busy} onClick={() => decide(lesson, 'dismiss')} className="tap rounded-lg border border-line px-3 text-sm font-bold hover:bg-paper disabled:opacity-60">{conflict ? 'همان قبلی بماند' : 'یاد نگیر'}</button>
    </div>}
  </li>;
}

function StructuralLesson({ lesson, canDecide, busy, decide }) {
  const parser = parserLabel(lesson);
  return <li className="py-3">
    <p className="text-sm leading-6">{lesson.sample}</p>
    <ul className="mt-1.5 flex flex-wrap gap-1.5">{lesson.flags.map((flag) => <li key={flag.id} className="rounded-full border border-line bg-paper px-2.5 py-0.5 text-xs">{flag.label}</li>)}</ul>
    <p className="mt-1.5 text-xs leading-6 text-muted">{parser ? `پارسر: ${parser} · ` : ''}ثبت‌شده: {finalLabel(lesson.final)}</p>
    {canDecide && <button type="button" disabled={busy} onClick={() => decide(lesson, 'reviewed')} className="tap mt-2 rounded-lg border border-line px-3 text-sm font-bold hover:bg-paper disabled:opacity-60">دیدم</button>}
  </li>;
}

export function LearningPage({ categories, notify, role = '' }) {
  const [items, setItems] = useState([]);
  const [lessons, setLessons] = useState({ threshold: 2, lessons: [] });
  const [busyId, setBusyId] = useState('');
  const [draft, setDraft] = useState({ keyword: '', category: 'خوراک' });
  const canDecide = DECIDERS.includes(role);
  const canSetPolicy = POLICY_SETTERS.includes(role);
  const load = () => Promise.all([api.learnings(), api.aiLessons().catch(() => null)]).then(([learned, taught]) => {
    setItems(learned.items);
    if (taught) setLessons(taught);
  });
  // load یک Promise برمی‌گرداند؛ اگر مستقیم به useEffect داده شود، React همان را
  // تابع پاک‌سازی می‌پندارد و هنگام ترک صفحه صدایش می‌زند. نتیجه‌اش از کار افتادن
  // کل برنامه به محض رفتن از «یادگیری‌ها» به هر صفحهٔ دیگر بود.
  useEffect(() => { load(); }, []);
  const save = async () => { if (!draft.keyword.trim()) return; await api.saveLearning(draft); setDraft({ ...draft, keyword: '' }); notify('یادگیری تازه ذخیره شد.'); load(); };
  const update = async (item, category) => { await api.updateLearning(item.id, { keyword: item.keyword, category }); load(); };
  const remove = async (id) => { await api.deleteLearning(id); notify('این یادگیری حذف شد.'); load(); };
  const decide = async (lesson, decision) => {
    setBusyId(lesson.id);
    try {
      await api.decideAiLesson(lesson.id, decision);
      notify(decision === 'learn' || decision === 'replace' ? `از این به بعد «${lesson.keyword}» در دستهٔ «${lesson.category}» ثبت می‌شود.`
        : decision === 'reviewed' ? 'این اختلاف دیده‌شده علامت خورد.' : 'این مورد یاد گرفته نمی‌شود.');
      await load();
    } catch (error) { notify(error.message); } finally { setBusyId(''); }
  };
  const saveThreshold = async (value) => {
    try { const result = await api.saveAiLessonThreshold(Number(value)); notify(`از این به بعد بعد از ${toPersianDigits(result.threshold)} تأیید یاد گرفته می‌شود.`); await load(); } catch (error) { notify(error.message); }
  };
  const download = async () => { try { await api.downloadAiLessons(); } catch (error) { notify(error.message); } };
  const pending = lessons.lessons.filter((lesson) => lesson.kind === 'category' && ['watching', 'conflict'].includes(lesson.status));
  const structural = lessons.lessons.filter((lesson) => lesson.kind === 'structural' && lesson.status === 'open');
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">آنچه یاد گرفته‌ام</h1><p className="mt-2 text-sm leading-7 text-muted">نگاشت‌هایی که خودت ساخته‌ای یا تأیید کرده‌ای، و آنچه از ثبت‌های تأییدشدهٔ AI یاد گرفته شده. هر مورد را هر زمان بخواهی می‌توانی تغییر بدهی یا پاک کنی.</p><div className="mt-5 flex gap-2 rounded-xl border border-line bg-surface p-2"><input value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} placeholder="مثلاً اسنپ‌فود" className="tap min-w-0 flex-1 px-2 outline-none" /><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap max-w-32 rounded-lg border border-line px-2">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={save} className="tap grid place-items-center rounded-lg bg-accent text-on-fill hover:bg-accent/90 active:bg-accent/80" aria-label="افزودن"><Plus size={21} /></button></div><div className="mt-5 divide-y divide-line border-y border-line">{items.length ? items.map((item) => <div key={item.id} className="flex min-h-[64px] items-center gap-2"><span className="min-w-0 flex-1 truncate font-bold">{item.keyword}{SOURCE_LABELS[item.source] && <span className="ms-2 rounded-full border border-line px-2 py-0.5 text-[11px] font-bold text-muted">{SOURCE_LABELS[item.source]}</span>}</span><ChevronLeft size={17} className="text-muted" /><select value={item.category} onChange={(event) => update(item, event.target.value)} className="tap max-w-36 bg-transparent text-sm text-muted outline-none">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense" aria-label={`حذف ${item.keyword}`}><Trash2 size={18} /></button></div>) : <p className="py-10 text-center text-sm text-muted">هنوز نگاشت تأییدشده‌ای ندارم.</p>}</div>
    <HistoryLessons notify={notify} role={role} onLearned={load} />
    <section aria-labelledby="ai-lessons-title" className="mt-8">
      <h2 id="ai-lessons-title" className="text-lg font-extrabold">یادگیری از AI</h2>
      <p className="mt-2 text-sm leading-7 text-muted">وقتی AI جمله‌ای را درست‌تر از پارسر می‌فهمد و ثبتش تأیید می‌شود، یا حسابدار در صف سندی را تأیید می‌کند، اینجا می‌آید. تأیید حسابدار همان لحظه یاد گرفته می‌شود؛ دسته بعد از {toPersianDigits(lessons.threshold)} تأییدِ هم‌جهت خودکار یاد گرفته می‌شود و فقط دسته را عوض می‌کند، هرگز جهت پول را.</p>
      {canSetPolicy && <label className="mt-3 flex items-center gap-2 text-sm"><span>یادگیری خودکار بعد از</span><select value={lessons.threshold} onChange={(event) => saveThreshold(event.target.value)} className="tap rounded-lg border border-line bg-surface px-2">{[2, 3, 4, 5].map((value) => <option key={value} value={value}>{toPersianDigits(value)}</option>)}</select><span>تأیید</span></label>}
      <h3 className="mt-5 text-sm font-extrabold">در حال یادگیری</h3>
      {pending.length ? <ul className="mt-1 divide-y divide-line border-y border-line">{pending.map((lesson) => <CategoryLesson key={lesson.id} lesson={lesson} threshold={lessons.threshold} canDecide={canDecide} busy={busyId === lesson.id} decide={decide} />)}</ul>
        : <p className="mt-1 text-sm leading-7 text-muted">هنوز موردی نیست. وقتی «همه را اول AI بفهمد» روشن است، هر ثبت با پارسر مقایسه می‌شود.</p>}
      <h3 className="mt-5 text-sm font-extrabold">اختلاف‌های ساختاری</h3>
      <p className="mt-1 text-xs leading-6 text-muted">جهت پول، پولی که هنوز نرفته، پول شریک، انتقال و تسویه هرگز خودکار یاد گرفته نمی‌شوند؛ برای بهتر شدن خودِ پارسر جمع می‌شوند.</p>
      {structural.length ? <ul className="mt-1 divide-y divide-line border-y border-line">{structural.map((lesson) => <StructuralLesson key={lesson.id} lesson={lesson} canDecide={canDecide} busy={busyId === lesson.id} decide={decide} />)}</ul>
        : <p className="mt-1 text-sm leading-7 text-muted">اختلاف بازی نیست.</p>}
      <button type="button" onClick={download} className="tap mt-5 inline-flex items-center gap-2 rounded-lg border border-line px-3 text-sm font-bold hover:bg-paper"><Download size={17} aria-hidden="true" />دانلود گزارش اختلاف‌ها</button>
      <p className="mt-1 text-xs leading-6 text-muted">جملهٔ کامل هر ثبت در فایل هست، بدون نام دفتر و کاربر؛ پیش از فرستادن نگاهش کن.</p>
    </section>
  </main>;
}
