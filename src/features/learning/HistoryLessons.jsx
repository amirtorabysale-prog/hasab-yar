// «یادگیری از سابقهٔ دفتر»: پیشنهادهایی که از سندهای تأییدشدهٔ بکاپ درآمده‌اند
// (server/historyLearning.js). هیچ‌کدام بی‌تأیید به کار نمی‌رود.

import { CalendarClock, ChevronLeft, RefreshCw, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits, unitLabel } from '../../lib/format.js';

const DECIDERS = ['owner', 'manager'];
const ANALYZERS = ['owner', 'manager', 'accountant'];

function Evidence({ items = [] }) {
  if (!items.length) return null;
  return <details className="mt-1 text-xs leading-6 text-muted">
    <summary className="cursor-pointer select-none">{toPersianDigits(items.length)} سند نمونه</summary>
    <ul className="mt-1 space-y-0.5">{items.map((item) => <li key={item.entryId} className="numbers">
      سند {toPersianDigits(item.documentNumber || '—')} · {persianDate(item.occurredAt)}{item.amount ? ` · ${formatAmount(item.amount)} ${unitLabel()}` : ''}{item.text ? ` · ${item.text}` : ''}
    </li>)}</ul>
  </details>;
}

function Actions({ item, canDecide, busy, decide }) {
  if (!canDecide || item.status !== 'pending') return null;
  return <div className="mt-2 flex flex-wrap gap-2">
    <button type="button" disabled={busy} onClick={() => decide(item, item.conflict ? 'replace' : 'accept')} className="tap rounded-lg bg-accent px-3 text-sm font-bold text-on-fill hover:bg-accent/90 disabled:opacity-60">
      {item.conflict ? 'جایگزین کن' : item.kind === 'recurring' && item.amountMode === 'fixed' ? 'بساز' : 'یاد بگیر'}
    </button>
    <button type="button" disabled={busy} onClick={() => decide(item, 'dismiss')} className="tap rounded-lg border border-line px-3 text-sm font-bold hover:bg-paper disabled:opacity-60">لازم نیست</button>
  </div>;
}

function RecurringLesson({ item, ...props }) {
  const side = item.type === 'income' ? 'دریافت' : 'پرداخت';
  const amount = item.amountMode === 'fixed'
    ? `${formatAmount(item.amount)} ${unitLabel()}`
    : `بین ${formatAmount(item.amountMin)} و ${formatAmount(item.amountMax)} ${unitLabel()}`;
  return <li className="py-3">
    <p className="flex flex-wrap items-center gap-1.5 font-bold"><CalendarClock size={16} className="text-accent" aria-hidden="true" /><span>{item.title}</span></p>
    <p className="mt-1 text-sm leading-6">{side} ماهانه · {amount} · {item.type === 'income' ? 'به' : 'از'} {item.moneyAccountName} · حدود روز {toPersianDigits(item.dayOfMonth)} هر ماه</p>
    <p className="mt-0.5 text-xs leading-6 text-muted">
      حساب «{item.category}» · در {toPersianDigits(item.months)} ماه دیده شد
      {item.amountMode === 'variable' && ' · مبلغ ثابت نیست؛ ثبت دوره‌ای ساخته نمی‌شود، فقط واژه‌اش یاد گرفته می‌شود'}
    </p>
    {item.status === 'accepted' && <p className="mt-1 text-xs font-bold text-accent">{item.result?.recurringId ? `ثبت دوره‌ای ساخته شد · سررسید بعدی ${persianDate(item.result.nextDueAt)}` : 'یاد گرفته شد'}</p>}
    <Evidence items={item.evidence} />
    <Actions item={item} {...props} />
  </li>;
}

function KeywordLesson({ item, ...props }) {
  return <li className="py-3">
    <p className="flex flex-wrap items-center gap-1.5 font-bold"><span>«{item.keyword}»</span><ChevronLeft size={16} className="text-muted" aria-hidden="true" /><span className="text-accent">{item.category}</span></p>
    <p className="mt-0.5 text-xs leading-6 text-muted">در {toPersianDigits(item.entries)} سند و {toPersianDigits(item.months)} ماه همیشه به همین حساب رفته</p>
    {item.conflict && <p className="mt-1 text-xs leading-6 text-warn">الان «{item.keyword}» به «{item.conflict.category}» می‌رود؛ بی تأیید تو عوض نمی‌شود.</p>}
    {item.status === 'accepted' && <p className="mt-1 text-xs font-bold text-accent">یاد گرفته شد</p>}
    <Evidence items={item.evidence} />
    <Actions item={item} {...props} />
  </li>;
}

export function HistoryLessons({ notify, role = '', onLearned }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const canDecide = DECIDERS.includes(role);
  const canAnalyze = ANALYZERS.includes(role);
  useEffect(() => { api.historyLessons().then(setState).catch(() => setState({ items: [] })); }, []);

  const run = async (key, action, done) => {
    setBusy(key);
    try { const result = await action(); await done?.(result); } catch (error) { notify(error.message); } finally { setBusy(''); }
  };
  const analyze = () => run('analyze', api.analyzeHistoryLessons, (result) => {
    setState(result);
    notify(`${toPersianDigits(result.items.filter((item) => item.status === 'pending').length)} پیشنهاد از سابقهٔ دفتر.`);
  });
  const decide = (item, action) => run(item.id, () => api.decideHistoryLesson(item.id, action), async () => {
    setState(await api.historyLessons());
    if (action !== 'dismiss') { notify(item.kind === 'recurring' && item.amountMode === 'fixed' ? `ثبت دوره‌ای «${item.title}» ساخته شد.` : `از این به بعد «${item.keyword || item.title}» در «${item.category}» ثبت می‌شود.`); onLearned?.(); }
  });
  const forget = () => {
    if (!window.confirm('همهٔ آنچه از سابقهٔ دفتر یاد گرفته شد (واژه‌ها و ثبت‌های دوره‌ای) برگردانده شود؟')) return;
    run('forget', api.forgetHistoryLessons, async (result) => {
      setState(await api.historyLessons());
      notify(`${toPersianDigits(result.learnings)} واژه و ${toPersianDigits(result.recurring)} ثبت دوره‌ای برگشت.`);
      onLearned?.();
    });
  };

  if (!state) return null;
  const items = state.items || [];
  const recurring = items.filter((item) => item.kind === 'recurring' && item.status !== 'dismissed');
  const keywords = items.filter((item) => item.kind === 'keyword' && item.status !== 'dismissed');
  const accepted = items.some((item) => item.status === 'accepted');
  const props = { canDecide, decide };
  return <section aria-labelledby="history-lessons-title" className="mt-8">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="history-lessons-title" className="text-lg font-extrabold">یادگیری از سابقهٔ دفتر</h2>
      {canAnalyze && <button type="button" disabled={Boolean(busy)} onClick={analyze} className="tap inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-bold hover:bg-paper disabled:opacity-60">
        <RefreshCw size={16} aria-hidden="true" className={busy === 'analyze' ? 'animate-spin motion-reduce:animate-none' : ''} />تحلیل دوباره
      </button>}
    </div>
    <p className="mt-2 text-sm leading-7 text-muted">
      سندهای تأییدشدهٔ گذشته (مثلاً بکاپ پارسیان) خوانده می‌شوند: پرداخت‌ها و دریافت‌های ماهانه مثل اجاره و قبض، و واژه‌هایی که همیشه به یک حساب رفته‌اند. سند پیش‌نویس، تسویهٔ بدهی و سند چندسطری خوانده نمی‌شود. تا تأیید نکنی چیزی به کار نمی‌رود.
    </p>
    {state.analyzed && <p className="mt-1 text-xs leading-6 text-muted numbers">آخرین تحلیل {persianDate(state.analyzed.at)} · {toPersianDigits(state.analyzed.entries)} سند تأییدشده خوانده شد</p>}
    {state.analyzed && !state.analyzed.entries && <p className="mt-2 text-sm leading-7 text-warn">سند تأییدشده‌ای نیست. سندهای بکاپ را اول در دفتر روزنامه تأیید کن، بعد «تحلیل دوباره» را بزن.</p>}

    <h3 className="mt-5 text-sm font-extrabold">پرداخت و دریافت ماهانه</h3>
    {recurring.length ? <ul className="mt-1 divide-y divide-line border-y border-line">{recurring.map((item) => <RecurringLesson key={item.id} item={item} busy={busy === item.id} {...props} />)}</ul>
      : <p className="mt-1 text-sm leading-7 text-muted">الگوی ماهانه‌ای با شاهد کافی (دست‌کم سه ماه، همان حساب و همان بانک) پیدا نشد.</p>}

    <h3 className="mt-5 text-sm font-extrabold">واژه‌های شرح سند</h3>
    {keywords.length ? <ul className="mt-1 divide-y divide-line border-y border-line">{keywords.map((item) => <KeywordLesson key={item.id} item={item} busy={busy === item.id} {...props} />)}</ul>
      : <p className="mt-1 text-sm leading-7 text-muted">واژهٔ روشنی پیدا نشد.</p>}

    {!canDecide && items.some((item) => item.status === 'pending') && <p className="mt-2 text-xs leading-6 text-muted">تأیید این پیشنهادها با مدیر یا مالک دفتر است.</p>}
    {canDecide && accepted && <button type="button" disabled={Boolean(busy)} onClick={forget} className="tap mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-bold text-expense hover:bg-paper disabled:opacity-60">
      <Undo2 size={16} aria-hidden="true" />برگرداندن همهٔ یادگیری‌های سابقه
    </button>}
  </section>;
}
