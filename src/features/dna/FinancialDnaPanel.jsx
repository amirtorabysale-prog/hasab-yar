import { BarChart3 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

/**
 * توزیع هفتگی یک سری واحد از جنس «بزرگی» است، نه هویت؛ پس یک رنگ می‌گیرد و
 * روز اوج با برچسب مستقیم مشخص می‌شود، نه با رنگ دوم.
 */
function WeekdayBars({ rows }) {
  const peak = rows.reduce((best, item) => (item.percent > best.percent ? item : best), rows[0]);
  // سهم هر روز حدود یک‌هفتم است، پس مقیاس‌کردن به صد درصد همهٔ میله‌ها را به
  // ته نوار می‌چسباند و تفاوتشان دیده نمی‌شود. مقیاس نسبت به بیشترین مقدار
  // است و عدد واقعی کنارش می‌ماند، پس چیزی بزرگ‌نمایی نمی‌شود.
  const highest = Math.max(...rows.map((item) => item.percent), 1);
  return <div className="mt-3 space-y-1.5">
    {rows.map((item) => <div key={item.day} className="flex items-center gap-2" title={`${item.day}: ${formatAmount(item.amount)} تومان`}>
      <span className="w-16 shrink-0 text-xs text-muted">{item.day}</span>
      <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-paper">
        <div className="h-full rounded-full bg-accent" style={{ width: `${item.percent ? Math.max(4, Math.round((item.percent / highest) * 100)) : 0}%` }} />
      </div>
      <span className="numbers w-9 shrink-0 text-left text-xs font-bold text-muted">{toPersianDigits(item.percent)}٪</span>
      <span className="w-8 shrink-0">{item.day === peak.day && <span className="rounded-md bg-warn-bg px-1.5 py-0.5 text-xs font-bold text-accent">اوج</span>}</span>
    </div>)}
  </div>;
}

export function FinancialDnaPanel({ notify }) {
  const [dna, setDna] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.financialDna(6)
      .then((result) => { if (alive) setDna(result); })
      .catch((error) => { if (alive) notify(error.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [notify]);

  if (loading) return <div className="mt-4 h-32 animate-pulse rounded-2xl bg-surface" />;
  if (!dna) return null;

  // نبود داده یک واقعیت است، نه خطا؛ ادعای الگو روی دادهٔ کم بدتر از سکوت است.
  if (dna.sufficiency.level !== 'ok') {
    return <section className="mt-4 rounded-2xl border border-line bg-surface p-4">
      <h2 className="font-extrabold">DNA مالی این پرونده</h2>
      <p className="mt-2 text-[13px] leading-7 text-muted">{dna.message}</p>
      <p className="mt-3 rounded-lg bg-paper px-3 py-3 text-[12px] leading-6 text-muted">
        تا آن موقع هیچ الگویی نشان داده نمی‌شود. پروفایل غلط برای دفتر بدتر از نبودِ پروفایل است، چون بر پایه‌اش تصمیم گرفته می‌شود.
      </p>
    </section>;
  }

  const brief = dna.brief;
  const weekday = dna.traits.find((item) => item.id === 'weekday-pattern');
  return <div className="mt-4 space-y-4">
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-extrabold">پروفایل یک‌نگاهی پرونده</h2>
          <p className="mt-1 text-xs leading-6 text-muted">
            از {toPersianDigits(dna.sufficiency.activeDays)} روز فعال در {toPersianDigits(dna.sufficiency.months)} ماه ساخته شده است؛ هر عدد از ثبت‌های واقعی می‌آید، نه از پیش‌بینی.
          </p>
        </div>
        <BarChart3 size={22} className="shrink-0 text-accent" />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['شکل پرونده', brief.shape],
          ['سند در ماه', toPersianDigits(brief.documentsPerMonth)],
          ['انضباط ثبت', brief.discipline],
          ['ثبت معمول درآمد', `${formatAmount(brief.typicalIncome)} تومان`],
        ].map(([label, value]) => <div key={label} className="rounded-lg bg-paper p-3">
          <span className="text-xs text-muted">{label}</span>
          <b className="mt-1 block text-[13px] leading-6">{value}</b>
        </div>)}
      </div>
      <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[12px] leading-6 text-accent">{brief.workloadNote}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {brief.activeCategories.map((item) => <span key={item.category} className="rounded-md border border-line px-2 py-1 text-xs">
          {item.category} <span className="numbers text-muted">{toPersianDigits(item.count)}</span>
        </span>)}
      </div>
    </section>

    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="font-extrabold">اثر انگشت رفتاری</h2>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {dna.traits.map((trait) => <article key={trait.id} className="rounded-xl border border-line bg-paper p-3">
          <div className="flex items-baseline justify-between gap-2">
            <b className="text-[13px]">{trait.label}</b>
            <span className="text-[13px] font-extrabold text-accent">{trait.value}</span>
          </div>
          <p className="mt-2 text-xs leading-6 text-muted">{trait.detail}</p>
          {trait.id === 'weekday-pattern' && <WeekdayBars rows={weekday.evidence.byWeekday} />}
          {trait.id === 'expense-backbone' && trait.evidence.fixed.length > 0 && <div className="mt-3 space-y-1">
            {trait.evidence.fixed.slice(0, 4).map((item) => <div key={item.category} className="flex items-center justify-between text-xs">
              <span className="text-muted">{item.category}</span>
              <span className="flex shrink-0 items-baseline gap-2">
                <b className="numbers">{toPersianDigits(item.percent)}٪</b>
                <span className="text-muted">در {toPersianDigits(item.months)} ماه</span>
              </span>
            </div>)}
          </div>}
          {trait.id === 'income-concentration' && <div className="mt-3 space-y-1">
            {trait.evidence.top.map((item) => <div key={item.category} className="flex items-center justify-between text-xs">
              <span className="text-muted">{item.category}</span>
              <span className="numbers font-bold">{toPersianDigits(item.percent)}٪</span>
            </div>)}
          </div>}
          {trait.id === 'entry-discipline' && <p className="mt-3 text-xs leading-6 text-muted">
            فاصلهٔ معمول ثبت تا وقوع: <b className="numbers">{toPersianDigits(trait.evidence.typicalLagDays)}</b> روز ·
            همان‌روز: <b className="numbers">{toPersianDigits(trait.evidence.sameDayPercent)}٪</b> ·
            شلوغ‌ترین روز ثبت: <b className="numbers">{toPersianDigits(trait.evidence.busiestDayCount)}</b> سند
          </p>}
          <p className="mt-2 text-xs text-muted">بر پایهٔ {toPersianDigits(trait.evidence.sample ?? trait.evidence.total ?? 0)} ثبت</p>
        </article>)}
      </div>
    </section>
  </div>;
}
