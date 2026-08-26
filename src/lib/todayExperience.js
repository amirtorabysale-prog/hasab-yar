const formatNumber = (value) => new Intl.NumberFormat('fa-IR').format(Math.round(Number(value) || 0));

export function todayExamples(profileType = 'business') {
  return profileType === 'personal'
    ? ['امروز ۳۵ میلیون حقوق گرفتم', 'یک میلیون و دویست اجاره دادم', 'قسط بانک ۸۵۰ هزار تومان پرداخت شد']
    : ['امروز ۱۲ میلیون فروش داشتم', '۷۵۰ هزار تومان هزینه پیک دادم', 'رضا ۲ میلیون تومان بدهکار شد'];
}

export function todayComposerState({ recordState = 'idle', manualText = '', reviewing = false, savedRecently = false } = {}) {
  if (savedRecently) return 'success';
  if (reviewing) return 'review';
  if (recordState === 'recording' || recordState === 'requesting') return 'listening';
  if (recordState === 'processing' || recordState === 'finalizing' || String(manualText).trim()) return 'typing';
  return 'ready';
}

export function buildTodayPulse({ summary = {}, overview = {}, transactions = [] } = {}) {
  if (overview.priorityAlert) {
    const alert = overview.priorityAlert;
    return {
      tone: alert.level === 'danger' ? 'danger' : 'warning',
      eyebrow: 'اولویت امروز',
      title: alert.title,
      detail: alert.detail,
      action: alert.action?.screen || null,
      actionTarget: alert.action?.tab || alert.action?.target || '',
      actionLabel: alert.action?.label || 'رسیدگی',
      alertId: alert.id,
    };
  }
  if (!Array.isArray(overview.alerts) && Number(overview.overdue) > 0) {
    return { tone: 'danger', eyebrow: 'نیاز به توجه', title: `${Number(overview.overdue)} سررسید عقب‌افتاده داری`, detail: 'اول سررسیدهای قدیمی را تعیین‌تکلیف کن تا تصویر نقدینگی واقعی‌تر بماند.', action: 'ledger', actionLabel: 'رسیدگی' };
  }
  if (!transactions.length) {
    return { tone: 'neutral', eyebrow: 'شروع روز', title: 'هنوز نبض امروز شکل نگرفته', detail: 'اولین دریافت یا پرداخت را بگو؛ بعد از همان ثبت، تصویر روز ساخته می‌شود.' };
  }
  const cashAlert = overview.alerts?.find((item) => item.action === 'reports' && /مانده|نقد/.test(item.title || ''));
  if (cashAlert) {
    return { tone: 'warning', eyebrow: 'نبض نقدینگی', title: cashAlert.title, detail: 'مانده حساب‌های نقدی را با صندوق و بانک تطبیق بده و پرداخت‌های نزدیک را مرور کن.' };
  }
  const net = Number(summary.netCashFlow ?? summary.profit ?? 0);
  if (net < 0) {
    return { tone: 'danger', eyebrow: 'نبض امروز', title: 'پرداخت امروز از دریافت بیشتر است', detail: `${formatNumber(Math.abs(net))} تومان خروج نقدی خالص ثبت شده؛ یک‌بار هزینه‌های امروز را مرور کن.` };
  }
  if (Number(overview.runwayDays) <= 14 && overview.runwayDays != null) {
    return { tone: 'warning', eyebrow: 'نبض نقدینگی', title: `دوام نقدینگی حدود ${Number(overview.runwayDays)} روز است`, detail: 'وصول طلب‌های نزدیک و پرداخت‌های پیش رو را همین امروز مرور کن.' };
  }
  return { tone: 'good', eyebrow: 'نبض امروز', title: 'جریان نقدی امروز مثبت است', detail: `${formatNumber(net)} تومان دریافت خالص بیشتر از پرداخت ثبت شده است.` };
}

export function buildTodayTasks({ transactions = [], overview = {}, closing = null, profileType = 'business', pendingAudioCount = 0 } = {}) {
  const tasks = [];
  if (pendingAudioCount > 0) tasks.push({ id: 'pending-audio', tone: 'warning', action: 'none', title: `${pendingAudioCount} صدای ذخیره‌شده هنوز همگام نشده`, detail: 'با اتصال پایدار، پردازش خودکار ادامه پیدا می‌کند.' });
  const suspiciousCount = transactions.filter((item) => item.needsReview).length;
  if (suspiciousCount > 0) tasks.push({ id: 'review', tone: 'warning', action: 'ledger', title: `${suspiciousCount} ثبت نیاز به بازبینی دارد`, detail: 'مبلغ یا دسته را پیش از بستن روز دوباره بررسی کن.' });
  if (Number(overview.overdue) > 0) tasks.push({ id: 'overdue', tone: 'danger', action: 'ledger', title: `${Number(overview.overdue)} سررسید عقب‌افتاده`, detail: 'طلب یا بدهی عقب‌افتاده را تسویه یا زمان‌بندی کن.' });
  if (closing && Number(closing.difference) !== 0) tasks.push({ id: 'cash-mismatch', tone: 'danger', action: 'close', title: `${formatNumber(Math.abs(Number(closing.difference)))} تومان اختلاف صندوق`, detail: 'علت ثبت‌شده را تکمیل کن یا صندوق را دوباره بشمار.' });
  if (profileType === 'business' && transactions.length > 0 && !closing) tasks.push({ id: 'close-day', tone: 'primary', action: 'close', title: 'امروز هنوز بسته نشده', detail: 'صندوق را بشمار و اختلاف احتمالی را ثبت کن.' });
  return tasks;
}

export function closingDifference(expectedCash, countedCash) {
  const counted = Math.max(0, Math.round(Number(countedCash) || 0));
  return counted - Math.round(Number(expectedCash) || 0);
}
