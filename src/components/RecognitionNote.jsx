import { formatAmount, toPersianDigits } from '../lib/format.js';

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const dayFormat = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric' });

/** «۱۸ مهر ۱۴۰۵» — با سال، چون اشتباه دوره معمولاً همان سال است. */
export function coverageDate(iso) {
  const parsed = iso ? new Date(iso) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? dayFormat.format(parsed) : '—';
}

/** «1405-07» → «مهر ۱۴۰۵». */
export function periodKeyLabel(periodKey) {
  const [year, month] = String(periodKey || '').split('-').map(Number);
  return year && MONTHS[month - 1] ? `${MONTHS[month - 1]} ${toPersianDigits(year)}` : toPersianDigits(periodKey || '');
}

/**
 * دورهٔ پوشش و برنامهٔ ماهانه‌ای که با تأیید ثبت می‌شود.
 *
 * برگهٔ تأیید پیش از این فقط سطر «بدهکار پیش‌پرداخت» را نشان می‌داد؛ دوره‌ای که
 * سرور از «یک ساله» یا جواب سؤال ساخته بود و دوازده قسطی که هر ماه هزینه
 * می‌شود، تا بعد از ثبت دیده نمی‌شد. همین برگه تنها جایی است که کاربر پیش از
 * ثبت می‌تواند دورهٔ سیزده‌ماهه یا سال اشتباه را ببیند. برای درآمد انتقالی همان
 * متن است: قسط ماهانهٔ درآمد.
 *
 * دورهٔ گذشته یا همین ماه برنامه ندارد و یک‌جا شناسایی می‌شود؛ آن هم گفته
 * می‌شود تا معلوم باشد چرا کل مبلغ هزینه شد.
 */
export function RecognitionNote({ recognition, servicePeriod, decided = false }) {
  if (recognition?.schedule?.length) {
    const { schedule } = recognition;
    const first = schedule[0];
    const last = schedule[schedule.length - 1];
    return <p aria-label="دورهٔ پوشش و برنامهٔ شناسایی" className="mt-1 block rounded-md bg-accent/5 px-2 py-1 text-[11px] leading-5 text-ink">
      پوشش <b>{coverageDate(recognition.periodStart)}</b> تا <b>{coverageDate(recognition.periodEnd)}</b> — <span className="numbers">{toPersianDigits(recognition.count || schedule.length)}</span> قسط ماهانهٔ <span className="numbers">{formatAmount(first.amount)}</span> تومان،
      از {periodKeyLabel(first.periodKey)} تا {periodKeyLabel(last.periodKey)}
    </p>;
  }
  if (decided && servicePeriod?.start && servicePeriod?.end) {
    return <p aria-label="دورهٔ پوشش" className="mt-1 block text-[11px] leading-5 text-muted">
      پوشش {coverageDate(servicePeriod.start)} تا {coverageDate(servicePeriod.end)} — یک‌جا در همین دوره شناسایی می‌شود
    </p>;
  }
  return null;
}
