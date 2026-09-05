// چیدمان کاری صفحهٔ «تحویل به حسابدار».
//
// این صفحه گیج‌کننده بود چون دو کار کاملاً متفاوت را در هم می‌ریخت: تنظیمی که
// یک بار برای هر نصب مقصد انجام می‌شود، و کاری که هر ماه روی دادهٔ همان ماه
// تکرار می‌شود. وقتی کنترل‌های هر دو در یک فهرست بلند کنار هم می‌آمدند، کاربر
// نمی‌فهمید باید یک تنظیم را درست کند یا یک سند را — و بدتر، «چیدمان ستون‌ها»
// که یک تنظیم اولیه است، پایین‌تر از دکمهٔ ساخت بسته قرار داشت.

export const SETUP_CHECK_IDS = Object.freeze([
  'template', 'parsian-template', 'chart', 'mappings', 'parsian-fiscal-year',
]);

export function isSetupCheck(check) {
  return SETUP_CHECK_IDS.includes(check?.id);
}

// کنترل «advisory» یک توصیه است، نه مانع؛ نباید گام را قرمز کند.
function blockingOf(checks) {
  return checks.filter((item) => !item.passed && item.severity !== 'advisory');
}

export function splitReadinessChecks(readiness = {}) {
  const checks = readiness.checks || [];
  const setup = checks.filter(isSetupCheck);
  const month = checks.filter((item) => !isSetupCheck(item));
  return { setup, month, setupBlocking: blockingOf(setup), monthBlocking: blockingOf(month) };
}

/**
 * چهار گام به همان ترتیبی که کار واقعاً انجام می‌شود:
 * اول مقصد، بعد تنظیم یک‌باره، بعد دادهٔ این ماه، آخر ساخت بسته.
 */
export function deliverySteps(readiness = {}, targetLabel = '') {
  const { setup, month, setupBlocking, monthBlocking } = splitReadinessChecks(readiness);
  return [
    {
      id: 'target',
      title: 'مقصد',
      hint: targetLabel || 'انتخاب نشده',
      done: Boolean(targetLabel),
      blocking: 0,
    },
    {
      id: 'setup',
      title: 'تنظیم یک‌باره',
      hint: setupBlocking.length ? setupBlocking[0].label : 'فایل پایه، چیدمان ستون و نگاشت حساب‌ها آماده است',
      done: setup.length > 0 && setupBlocking.length === 0,
      blocking: setupBlocking.length,
    },
    {
      id: 'month',
      title: 'دادهٔ این ماه',
      hint: monthBlocking.length ? monthBlocking[0].label : 'ثبت‌های این دوره کنترل شده‌اند',
      done: month.length > 0 && monthBlocking.length === 0,
      blocking: monthBlocking.length,
    },
    {
      id: 'deliver',
      title: 'ساخت و تحویل',
      hint: readiness.ready ? 'می‌توانی بسته را بسازی' : 'تا رفع موارد بالا قفل است',
      done: false,
      blocking: readiness.ready ? 0 : 1,
    },
  ];
}
