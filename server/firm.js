// میز کار دفتر حسابداری — منطق خالص و قابل آزمون.
// این ماژول به دیتابیس دست نمی‌زند؛ فقط snapshot هر پرونده را به وضعیت قابل اقدام تبدیل می‌کند.

export const FIRM_STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// موارد بازدارنده: تا وقتی صفر نشوند، تحویل ماه به نرم‌افزار مقصد معنا ندارد.
export const FIRM_BLOCKER_RULES = Object.freeze([
  Object.freeze({ id: 'openReceipts', label: 'رسید بازبینی‌نشده', field: 'openReceipts' }),
  Object.freeze({ id: 'unexplainedClosings', label: 'اختلاف صندوق بدون توضیح', field: 'unexplainedClosings' }),
  Object.freeze({ id: 'unmatchedBankLines', label: 'ردیف بانکی تطبیق‌نشده', field: 'unmatchedBankLines' }),
  Object.freeze({ id: 'openRequests', label: 'درخواست توضیح بی‌پاسخ', field: 'openRequests' }),
  Object.freeze({ id: 'pendingApproval', label: 'سند کنترل‌نشده', field: 'pendingApproval' }),
]);

// مواردی که تحویل را متوقف نمی‌کنند اما کار حسابدار را روی میز نگه می‌دارند.
export const FIRM_WARNING_RULES = Object.freeze([
  Object.freeze({ id: 'unreviewedTransactions', label: 'ثبت بررسی‌نشده', field: 'unreviewedTransactions' }),
  Object.freeze({ id: 'answeredRequests', label: 'پاسخ در انتظار کنترل حسابدار', field: 'answeredRequests' }),
  Object.freeze({ id: 'overdueObligations', label: 'طلب یا بدهی سررسیدگذشته', field: 'overdueObligations' }),
]);

const LEVEL_ORDER = Object.freeze({ blocked: 0, attention: 1, ready: 2, unknown: 3 });

export const FIRM_LEVEL_LABELS = Object.freeze({
  blocked: 'نیازمند رفع ایراد',
  attention: 'در انتظار کنترل',
  ready: 'آمادهٔ تحویل',
  unknown: 'وضعیت نامشخص',
});

function wholeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

// هم قالب ISO خودمان و هم قالب `YYYY-MM-DD HH:MM:SS` پیش‌فرض SQLite را می‌خواند.
// SQLite این مقدار را به وقت UTC می‌نویسد، پس نبود پسوند Z باید صریح جبران شود.
export function parseStoredMoment(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const text = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const parseMoment = parseStoredMoment;

// تعداد روز بی‌فعالیتی؛ اگر هیچ فعالیتی ثبت نشده باشد null برمی‌گردد، نه صفر جعلی.
export function idleDays(lastActivityAt, now = new Date()) {
  const moment = parseMoment(lastActivityAt);
  if (!moment) return null;
  return Math.max(0, Math.floor((now.getTime() - moment.getTime()) / DAY_MS));
}

/**
 * وضعیت یک پروندهٔ مشتری را از snapshot خام می‌سازد.
 * snapshot.available=false یعنی خواندن دیتابیس آن پرونده ممکن نشده؛ در این حالت
 * هیچ عددی حدس زده نمی‌شود و سطح `unknown` برمی‌گردد.
 */
export function firmClientStatus(snapshot = {}, { now = new Date(), staleAfterDays = FIRM_STALE_AFTER_DAYS } = {}) {
  const workspace = snapshot.workspace || null;
  if (snapshot.available === false) {
    return {
      workspace,
      month: snapshot.month || null,
      level: 'unknown',
      levelLabel: FIRM_LEVEL_LABELS.unknown,
      blockers: [],
      warnings: [],
      blockerTotal: null,
      warningTotal: null,
      readyForDelivery: false,
      idleDays: null,
      stale: false,
      periodLocked: null,
      ledgerBalanced: null,
      activity: null,
      delivery: null,
      error: snapshot.error || 'خواندن این پرونده ممکن نشد.',
    };
  }

  const counts = snapshot.counts || {};
  const blockers = FIRM_BLOCKER_RULES
    .map((rule) => ({ id: rule.id, label: rule.label, count: wholeCount(counts[rule.field]) }))
    .filter((item) => item.count > 0);

  const ledgerBalanced = snapshot.ledgerBalanced !== false;
  if (!ledgerBalanced) blockers.push({ id: 'ledgerUnbalanced', label: 'دفتر کل ماه نامتوازن است', count: 1 });

  const warnings = FIRM_WARNING_RULES
    .map((rule) => ({ id: rule.id, label: rule.label, count: wholeCount(counts[rule.field]) }))
    .filter((item) => item.count > 0);

  const idle = idleDays(snapshot.lastActivityAt, now);
  const stale = idle != null && idle >= staleAfterDays;
  if (stale) warnings.push({ id: 'stale', label: `${idle} روز بدون ثبت جدید`, count: idle });

  const level = blockers.length ? 'blocked' : warnings.length ? 'attention' : 'ready';
  return {
    workspace,
    month: snapshot.month || null,
    level,
    levelLabel: FIRM_LEVEL_LABELS[level],
    blockers,
    warnings,
    blockerTotal: blockers.reduce((sum, item) => sum + item.count, 0),
    warningTotal: warnings.reduce((sum, item) => sum + item.count, 0),
    readyForDelivery: level === 'ready',
    idleDays: idle,
    stale,
    periodLocked: snapshot.periodLocked ?? null,
    ledgerBalanced,
    activity: snapshot.activity || null,
    delivery: snapshot.delivery || null,
    error: null,
  };
}

// فوری‌ترین پرونده بالای جدول می‌نشیند؛ ترتیب الفبایی فقط برای هم‌ارزهاست.
export function sortFirmClients(clients = []) {
  return [...clients].sort((first, second) => {
    const levelDiff = (LEVEL_ORDER[first.level] ?? 9) - (LEVEL_ORDER[second.level] ?? 9);
    if (levelDiff) return levelDiff;
    const blockerDiff = (second.blockerTotal || 0) - (first.blockerTotal || 0);
    if (blockerDiff) return blockerDiff;
    const warningDiff = (second.warningTotal || 0) - (first.warningTotal || 0);
    if (warningDiff) return warningDiff;
    return String(first.workspace?.name || '').localeCompare(String(second.workspace?.name || ''), 'fa');
  });
}

export function firmPortfolioSummary(clients = []) {
  const counted = clients.filter((item) => item.level !== 'unknown');
  const byBlocker = new Map();
  for (const client of counted) {
    for (const blocker of client.blockers) {
      const current = byBlocker.get(blocker.id) || { id: blocker.id, label: blocker.label, clients: 0, count: 0 };
      current.clients += 1;
      current.count += blocker.count;
      byBlocker.set(blocker.id, current);
    }
  }
  return {
    clientCount: clients.length,
    measuredCount: counted.length,
    unavailableCount: clients.length - counted.length,
    blocked: counted.filter((item) => item.level === 'blocked').length,
    attention: counted.filter((item) => item.level === 'attention').length,
    ready: counted.filter((item) => item.level === 'ready').length,
    stale: counted.filter((item) => item.stale).length,
    // درصد آمادگی وقتی هیچ پروندهٔ قابل اندازه‌گیری نیست null می‌ماند و به صفر تبدیل نمی‌شود.
    readyPercent: counted.length ? Math.round((counted.filter((item) => item.level === 'ready').length / counted.length) * 100) : null,
    topBlockers: [...byBlocker.values()].sort((first, second) => second.clients - first.clients || second.count - first.count),
  };
}

export function buildFirmPortfolio(snapshots = [], options = {}) {
  const clients = sortFirmClients(snapshots.map((item) => firmClientStatus(item, options)));
  return { clients, summary: firmPortfolioSummary(clients) };
}
