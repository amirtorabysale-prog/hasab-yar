// DNA مالی — اثر انگشت رفتاری هر پرونده و پروفایلی که دفتر با یک نگاه بفهمد.
//
// این ماژول به دیتابیس دست نمی‌زند؛ فقط ردیف‌های ثبت‌شده را به صفت‌های رفتاری
// تبدیل می‌کند تا بتوان همهٔ مسیرها را بدون دیتابیس آزمود.
//
// یک قاعدهٔ سخت دارد: **هیچ صفتی بدون دادهٔ کافی ادعا نمی‌شود.** هر صفت
// نمونه‌اش را حمل می‌کند و وقتی داده کم است، به‌جای حدسِ قشنگ، صریح می‌گوید
// «هنوز نمی‌دانم». پروفایل غلط برای دفتر حسابداری بدتر از نبودِ پروفایل است،
// چون بر پایه‌اش تصمیم می‌گیرد.

const DAY_MS = 24 * 60 * 60 * 1000;

// حداقل‌هایی که زیرشان هر ادعایی نویز است، نه الگو.
export const DNA_MINIMUMS = Object.freeze({
  transactions: 20,
  activeDays: 8,
  weeksForWeekday: 4,
  monthsForBackbone: 2,
});

export const WEEKDAY_LABELS = Object.freeze(['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه']);

const WEEKDAY_INDEX = Object.freeze({ Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6 });

function parseMoment(value) {
  if (!value) return null;
  const raw = String(value).trim();
  // هم قالب ISO خودمان و هم `YYYY-MM-DD HH:MM:SS` پیش‌فرض SQLite که به وقت UTC نوشته می‌شود.
  const text = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function tehranParts(date, timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const parts = Object.fromEntries(format.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    weekday: WEEKDAY_INDEX[parts.weekday] ?? null,
  };
}

/**
 * ماه و روزِ شمسی.
 *
 * صفت‌ها فقط «چند ماه» را می‌شمارند و آنجا تفاوت تقویم اثری ندارد. اما «معمولاً
 * چندم ماه» و «همین ماه ثبت شده یا نه» را کاربر با تقویم شمسی می‌فهمد؛ مرز ماه
 * میلادی وسط ماه شمسی می‌افتد و اجارهٔ اول ماه را به دو ماه مختلف می‌برد.
 */
function persianParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { month: `${parts.year}-${parts.month}`, day: Number(parts.day) };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function share(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** ردیف خام را به شکل قابل تحلیل می‌آورد و ردیف بی‌تاریخ را کنار می‌گذارد. */
export function normalizeDnaRows(rows = [], timeZone = 'Asia/Tehran') {
  return rows.map((row) => {
    const occurredAt = parseMoment(row.occurredAt);
    if (!occurredAt) return null;
    const createdAt = parseMoment(row.createdAt) || occurredAt;
    const amount = Math.round(Number(row.amount) || 0);
    if (amount <= 0) return null;
    const type = row.type === 'income' ? 'income' : 'expense';
    const when = tehranParts(occurredAt, timeZone);
    const persian = persianParts(occurredAt, timeZone);
    return {
      amount,
      type,
      category: String(row.category || '').trim() || (type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها'),
      source: String(row.source || 'text'),
      occurredAt,
      createdAt,
      day: when.day,
      month: when.month,
      fiscalMonth: persian.month,
      fiscalDay: persian.day,
      weekday: when.weekday,
      // فاصلهٔ ثبت تا وقوع؛ منفی یعنی ساعت‌گرد، پس صفر می‌شود.
      lagDays: Math.max(0, Math.floor((createdAt.getTime() - occurredAt.getTime()) / DAY_MS)),
    };
  }).filter(Boolean);
}

function sufficiencyOf(rows) {
  const days = new Set(rows.map((row) => row.day)).size;
  const months = new Set(rows.map((row) => row.month)).size;
  if (rows.length < DNA_MINIMUMS.transactions || days < DNA_MINIMUMS.activeDays) {
    return {
      level: 'thin',
      months,
      activeDays: days,
      reason: `برای اثر انگشت رفتاری حداقل ${DNA_MINIMUMS.transactions} ثبت در ${DNA_MINIMUMS.activeDays} روز لازم است؛ فعلاً ${rows.length} ثبت در ${days} روز هست.`,
    };
  }
  return { level: 'ok', months, activeDays: days, reason: '' };
}

// ---------------------------------------------------------------------------
// صفت‌ها
// ---------------------------------------------------------------------------

function incomeRhythm(rows, months) {
  const income = rows.filter((row) => row.type === 'income');
  if (!income.length) return null;
  const perMonth = income.length / Math.max(1, months);
  const typical = median(income.map((row) => row.amount));
  const shape = perMonth >= 30 ? 'روزانه و پرتعداد' : perMonth <= 8 ? 'پروژه‌ای و کم‌تعداد' : 'ترکیبی';
  const detail = shape === 'روزانه و پرتعداد'
    ? 'درآمد از فروش‌های خرد و مکرر می‌آید؛ کنترل روزانهٔ صندوق مهم‌تر از کنترل تک‌سند است.'
    : shape === 'پروژه‌ای و کم‌تعداد'
      ? 'درآمد در چند سند درشت می‌آید؛ هر سند وزن زیادی دارد و اشتباهش گران است.'
      : 'ترکیبی از فروش خرد و سند درشت.';
  return {
    id: 'income-rhythm',
    label: 'ریتم درآمد',
    value: shape,
    detail,
    evidence: { perMonth: Math.round(perMonth * 10) / 10, typicalAmount: typical, sample: income.length },
  };
}

function weekdayPattern(rows) {
  const income = rows.filter((row) => row.type === 'income' && row.weekday !== null);
  const weeks = new Set(income.map((row) => row.day)).size / 7;
  if (weeks < DNA_MINIMUMS.weeksForWeekday) return null;
  const totals = WEEKDAY_LABELS.map(() => 0);
  for (const row of income) totals[row.weekday] += row.amount;
  const sum = totals.reduce((left, right) => left + right, 0);
  if (!sum) return null;
  const ranked = totals.map((amount, index) => ({ index, amount })).sort((left, right) => right.amount - left.amount);
  const strongest = ranked[0];
  const weakest = ranked.at(-1);
  return {
    id: 'weekday-pattern',
    label: 'الگوی هفتگی',
    value: `اوج ${WEEKDAY_LABELS[strongest.index]}`,
    detail: `${share(strongest.amount, sum)}٪ درآمد در ${WEEKDAY_LABELS[strongest.index]} و کمترین سهم در ${WEEKDAY_LABELS[weakest.index]} ثبت شده است.`,
    evidence: { byWeekday: totals.map((amount, index) => ({ day: WEEKDAY_LABELS[index], amount, percent: share(amount, sum) })), sample: income.length },
  };
}

function expenseBackbone(rows, months) {
  const expense = rows.filter((row) => row.type === 'expense');
  if (!expense.length || months < DNA_MINIMUMS.monthsForBackbone) return null;
  const byCategory = new Map();
  for (const row of expense) {
    const entry = byCategory.get(row.category) || { total: 0, months: new Set(), count: 0 };
    entry.total += row.amount;
    entry.months.add(row.month);
    entry.count += 1;
    byCategory.set(row.category, entry);
  }
  const total = expense.reduce((sum, row) => sum + row.amount, 0);
  // دسته‌ای که در بیشتر ماه‌ها تکرار می‌شود، ستون فقرات ثابت است.
  // آستانه عمداً ۶۰٪ است نه ۷۰٪: اجاره و حقوق گاهی یکی-دو روز جابه‌جا پرداخت
  // می‌شوند و به ماه بعد می‌افتند؛ آستانهٔ سخت‌گیرانه واقعی‌ترین هزینه‌های ثابت
  // را بیرون می‌انداخت. کف دو ماه می‌ماند تا خرید یک‌باره هرگز ثابت شمرده نشود،
  // و تعداد ماه کنار هر دسته نمایش داده می‌شود تا قضاوت با خود حسابدار باشد.
  const requiredMonths = Math.max(2, Math.round(months * 0.6));
  const fixed = [...byCategory.entries()]
    .filter(([, entry]) => entry.months.size >= requiredMonths)
    .map(([category, entry]) => ({ category, total: entry.total, percent: share(entry.total, total), months: entry.months.size }))
    .sort((left, right) => right.total - left.total);
  const fixedTotal = fixed.reduce((sum, item) => sum + item.total, 0);
  return {
    id: 'expense-backbone',
    label: 'ستون فقرات هزینه',
    value: fixed.length ? `${share(fixedTotal, total)}٪ هزینهٔ تکرارشونده` : 'هزینهٔ تکرارشوندهٔ روشنی ندارد',
    detail: fixed.length
      ? `${fixed.slice(0, 3).map((item) => item.category).join('، ')} تقریباً هر ماه تکرار می‌شوند؛ بقیهٔ هزینه‌ها متغیرند.`
      : 'هیچ دستهٔ هزینه‌ای در بیشتر ماه‌ها تکرار نشده است.',
    evidence: { fixedPercent: share(fixedTotal, total), fixed: fixed.slice(0, 5), sample: expense.length },
  };
}

function incomeConcentration(rows) {
  const income = rows.filter((row) => row.type === 'income');
  if (!income.length) return null;
  const byCategory = new Map();
  for (const row of income) byCategory.set(row.category, (byCategory.get(row.category) || 0) + row.amount);
  const total = income.reduce((sum, row) => sum + row.amount, 0);
  const ranked = [...byCategory.entries()].map(([category, amount]) => ({ category, amount, percent: share(amount, total) })).sort((left, right) => right.amount - left.amount);
  const top = ranked[0];
  return {
    id: 'income-concentration',
    label: 'تمرکز درآمد',
    value: `${top.percent}٪ از «${top.category}»`,
    detail: top.percent >= 70
      ? 'درآمد تقریباً تک‌منبعی است؛ قطع همین یک منبع کل جریان نقدی را می‌خواباند.'
      : 'درآمد میان چند منبع پخش شده است.',
    evidence: { top: ranked.slice(0, 4), sample: income.length },
  };
}

/**
 * انضباط ثبت — مهم‌ترین صفت برای دفتر حسابداری.
 * تفاوت «مشتری که هر روز ثبت می‌کند» با «مشتری که روز آخر ماه شصت سند می‌ریزد»
 * مستقیم روی برنامهٔ کاری دفتر اثر دارد و از هیچ گزارش مالی دیگری پیدا نیست.
 */
function entryDiscipline(rows) {
  if (!rows.length) return null;
  const lags = rows.map((row) => row.lagDays);
  const sameDay = rows.filter((row) => row.lagDays === 0).length;
  const typicalLag = median(lags);
  const byCreationDay = new Map();
  for (const row of rows) {
    const key = row.createdAt.toISOString().slice(0, 10);
    byCreationDay.set(key, (byCreationDay.get(key) || 0) + 1);
  }
  const counts = [...byCreationDay.values()];
  const busiest = Math.max(...counts);
  const bulkShare = share(counts.filter((count) => count >= 10).reduce((sum, count) => sum + count, 0), rows.length);
  const value = typicalLag === 0 && bulkShare < 40 ? 'روزانه و به‌موقع'
    : bulkShare >= 40 ? 'انبوه و دیرهنگام'
      : 'نامنظم';
  return {
    id: 'entry-discipline',
    label: 'انضباط ثبت',
    value,
    detail: value === 'روزانه و به‌موقع'
      ? 'ثبت‌ها همان روز وقوع وارد می‌شوند؛ کار دفتر در پایان ماه سبک است.'
      : value === 'انبوه و دیرهنگام'
        ? 'بخش بزرگی از ثبت‌ها یک‌جا و با تأخیر وارد می‌شوند؛ بار کنترل دفتر روی پایان دوره متمرکز می‌شود.'
        : 'ثبت‌ها نه کاملاً روزانه‌اند و نه یک‌جا؛ کنترل باید در طول ماه پخش شود.',
    evidence: { typicalLagDays: typicalLag, sameDayPercent: share(sameDay, rows.length), busiestDayCount: busiest, bulkPercent: bulkShare, sample: rows.length },
  };
}

function voiceAdoption(rows) {
  if (!rows.length) return null;
  const voice = rows.filter((row) => row.source === 'voice').length;
  return {
    id: 'voice-adoption',
    label: 'سهم ثبت صوتی',
    value: `${share(voice, rows.length)}٪`,
    detail: 'نسبت ثبت‌هایی که با صدا وارد شده‌اند؛ برای سنجش اینکه ابزار واقعاً جا افتاده یا نه.',
    evidence: { voice, total: rows.length },
  };
}

// ---------------------------------------------------------------------------

/**
 * پروفایل یک‌نگاهی برای دفتر: شکل پرونده، بار کاری ماهانه و آنچه باید بداند.
 * عمداً هیچ عدد پیش‌بینی‌شده‌ای ندارد؛ فقط آنچه واقعاً ثبت شده است.
 */
function accountantBrief(rows, months, traits) {
  const income = rows.filter((row) => row.type === 'income');
  const expense = rows.filter((row) => row.type === 'expense');
  const rhythm = traits.find((item) => item.id === 'income-rhythm');
  const discipline = traits.find((item) => item.id === 'entry-discipline');
  const perMonth = Math.round(rows.length / Math.max(1, months));
  const categories = new Map();
  for (const row of rows) categories.set(row.category, (categories.get(row.category) || 0) + 1);
  return {
    shape: rhythm?.value || 'نامشخص',
    documentsPerMonth: perMonth,
    typicalIncome: median(income.map((row) => row.amount)),
    typicalExpense: median(expense.map((row) => row.amount)),
    activeCategories: [...categories.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6).map(([category, count]) => ({ category, count })),
    discipline: discipline?.value || 'نامشخص',
    workloadNote: perMonth >= 120
      ? 'حجم ثبت بالاست؛ کنترل نمونه‌ای بهتر از کنترل تک‌به‌تک جواب می‌دهد.'
      : perMonth <= 15
        ? 'حجم ثبت کم است؛ کنترل تک‌به‌تک شدنی است.'
        : 'حجم ثبت متوسط است.',
  };
}

/**
 * اثر انگشت مالی یک پرونده.
 * `rows` همان ردیف‌های تراکنش دورهٔ موردنظر است؛ این تابع هیچ کوئری نمی‌زند.
 */
export function financialDna(rows = [], { timeZone = 'Asia/Tehran', now = new Date(), months = 0 } = {}) {
  const normalized = normalizeDnaRows(rows, timeZone);
  const sufficiency = sufficiencyOf(normalized);
  // مخرج باید ماه‌هایی باشد که واقعاً داده دارند، نه پنجره‌ای که درخواست شده.
  // وگرنه درخواست شش‌ماهه روی چهار ماه داده، آستانهٔ «تکرارشونده» را چنان بالا
  // می‌برد که اجاره و حقوق — یعنی واقعی‌ترین هزینه‌های ثابت — کنار می‌افتند.
  const monthCount = Math.max(1, sufficiency.months || months || 1);

  if (sufficiency.level !== 'ok') {
    return {
      generatedAt: now.toISOString(),
      sufficiency,
      traits: [],
      brief: null,
      // نبود داده یک واقعیت است، نه خطا؛ باید همان‌طور گفته شود.
      message: sufficiency.reason,
    };
  }

  const traits = [
    incomeRhythm(normalized, monthCount),
    weekdayPattern(normalized),
    expenseBackbone(normalized, monthCount),
    incomeConcentration(normalized),
    entryDiscipline(normalized),
    voiceAdoption(normalized),
  ].filter(Boolean);

  return {
    generatedAt: now.toISOString(),
    sufficiency,
    traits,
    brief: accountantBrief(normalized, monthCount, traits),
    message: '',
  };
}

// ---------------------------------------------------------------------------
// از پروفایل به تصمیم
// ---------------------------------------------------------------------------

/**
 * پروفایل هر دسته: چند بار ثبت شده، مبلغ معمولش چقدر است، در چند ماه دیده شده و
 * معمولاً چندم ماه می‌آید.
 *
 * تا امروز DNA فقط نمایش داده می‌شد. این خروجی همان دانش را به شکلی می‌دهد که
 * بتوان پیش از ثبت دربارهٔ یک گفته تصمیم گرفت: مبلغ نسبت به عادت خودِ این پرونده
 * سنجیده شود، نه نسبت به یک میانگین کلی که خرید ملک و خرید نان را با هم جمع
 * می‌کند.
 *
 * ساختار خروجی عمداً ساده و JSON است تا هم سرور و هم مرورگر — که ثبت متنی را
 * محلی پارس می‌کند — از یک منبع تصمیم بگیرند.
 */
export function dnaCategoryProfiles(rows = [], { timeZone = 'Asia/Tehran' } = {}) {
  const normalized = normalizeDnaRows(rows, timeZone);
  const grouped = new Map();
  for (const row of normalized) {
    const key = `${row.type}:${row.category}`;
    const entry = grouped.get(key) || { type: row.type, category: row.category, amounts: [], months: new Set(), days: [] };
    entry.amounts.push(row.amount);
    entry.months.add(row.fiscalMonth);
    entry.days.push(row.fiscalDay);
    grouped.set(key, entry);
  }
  return {
    totalRows: normalized.length,
    months: new Set(normalized.map((row) => row.fiscalMonth)).size,
    categories: [...grouped.values()].map((entry) => ({
      type: entry.type,
      category: entry.category,
      count: entry.amounts.length,
      median: median(entry.amounts),
      months: entry.months.size,
      typicalDay: median(entry.days),
    })),
  };
}

/**
 * دسته‌های تکرارشوندهٔ ماهانه‌ای که ماه جاری هنوز ثبت نشده‌اند و روز معمولشان
 * گذشته است.
 *
 * همان تعریف «ستون فقرات هزینه» در صفت‌ها استفاده می‌شود: دسته‌ای که در بیشتر
 * ماه‌ها تکرار شده. تفاوت اینجاست که خروجی، یک صفت برای تماشا نیست؛ یک کار
 * باقی‌مانده است.
 */
export function overdueBackboneCategories(profiles, recordedThisMonth = [], { dayOfMonth = 1 } = {}) {
  const recorded = new Set(recordedThisMonth.map((item) => `${item.type}:${item.category}`));
  const requiredMonths = Math.max(2, Math.round(Number(profiles.months || 0) * 0.6));
  if (profiles.months < DNA_MINIMUMS.monthsForBackbone) return [];
  return profiles.categories
    .filter((item) => item.type === 'expense' && item.months >= requiredMonths)
    // مهلت سه روز است، نه صفر: اجاره و حقوق یکی-دو روز جابه‌جا پرداخت می‌شوند و
    // هشدار روزِ سررسید فقط نویز می‌سازد.
    .filter((item) => dayOfMonth >= item.typicalDay + 3)
    .filter((item) => !recorded.has(`expense:${item.category}`))
    .sort((left, right) => right.median - left.median);
}
