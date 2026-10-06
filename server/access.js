export const ROLE_LABELS = {
  owner: 'مالک', manager: 'مدیر', accountant: 'حسابدار', viewer: 'فقط مشاهده',
};

const roleRank = { viewer: 0, accountant: 1, manager: 2, owner: 3 };

export function roleAllows(role, minimum) {
  return (roleRank[role] ?? -1) >= (roleRank[minimum] ?? Number.POSITIVE_INFINITY);
}

export function minimumRoleForRequest(method, path) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedPath = String(path || '');
  if (normalizedPath.startsWith('/collaboration/requests/') && normalizedPath.endsWith('/answer')) return 'manager';
  if (normalizedPath.startsWith('/collaboration/')) return 'accountant';
  // الگوی انتقال تعیین می‌کند هر فایل بعدی روی چه ساختاری نوشته شود؛ مثل
  // کدینگ، تغییرش کار مدیر دفتر است نه کمک‌حسابدار.
  if (normalizedPath === '/accountant-transfer/template') return 'manager';
  if (normalizedPath.startsWith('/accountant-transfer/')) return 'accountant';
  // میز کار دفتر: خروجی به عضویت‌های خود کاربر محدود است، پس نقش دفتر فعال آن را محدود نمی‌کند.
  if (normalizedPath.startsWith('/firm/')) return 'viewer';
  if (normalizedPath.startsWith('/pilot/')) return 'manager';
  if (normalizedPath.startsWith('/operations/')) return 'manager';
  if (normalizedPath.startsWith('/commercial/admin/')) return 'owner';
  if (normalizedPath === '/commercial/status') return 'viewer';
  if (['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return normalizedPath.startsWith('/backups/') ? 'manager' : 'viewer';
  // نام و بایگانی دفتر: مالکیت همان دفترِ هدف داخل تابع کنترل می‌شود، نه نقش دفتر فعال.
  if (normalizedPath.startsWith('/workspaces/')) return 'viewer';
  if (normalizedPath.startsWith('/auth/') || normalizedPath.startsWith('/alerts/') || (normalizedPath === '/workspaces' && normalizedMethod === 'POST') || normalizedPath === '/ask') return 'viewer';
  // تأیید و برگشت رویداد مالی، سند در دفتر کل می‌سازد یا معکوس می‌کند؛
  // این کار حسابدار است، نه هر کسی که می‌تواند ثبت روزانه بزند.
  if (/^\/financial-events\/[^/]+\/prior-basis$/.test(normalizedPath)) return 'manager';
  if (/^\/financial-events\/[^/]+\/(approve|reverse|reject)$/.test(normalizedPath)) return 'accountant';
  // پاسخ کاربر به پرسش خودش هم سند می‌سازد، پس رتبه‌اش همان است. تفاوتش با
  // مسیر بالا در تجربه است نه در اختیار: اینجا در محیط ساده هم باز می‌ماند.
  if (/^\/confirmations\/[^/]+\/(confirm|handover)$/.test(normalizedPath)) return 'accountant';
  if (normalizedPath.startsWith('/workspace/members')) return 'owner';
  if (normalizedPath.startsWith('/accounting/periods/')) return 'owner';
  // کنترل و تأیید سند کار حسابدار ارشد است، نه کمک‌حسابداری که ثبت می‌زند.
  if (/^\/accounting\/journal\/[^/]+\/approval$/.test(normalizedPath)) return 'manager';
  if (normalizedPath.startsWith('/accounting/templates')) return 'manager';
  if (normalizedPath.startsWith('/reconciliation/imports/') && normalizedPath.endsWith('/close')) return 'manager';
  // کدینگ، تفصیلی و مرکز هزینه دادهٔ پایهٔ دفترند، نه ثبت روزانه؛ تغییرشان در سطح تنظیمات است.
  if (normalizedPath.startsWith('/chart/')) return 'manager';
  // لیست حقوق هم دادهٔ شخصی پرسنل است و هم سندِ چندمیلیونی می‌سازد.
  if (normalizedPath.startsWith('/payroll')) return 'manager';
  // آستانهٔ ثبت خودکار، سیاست دفتر است نه تنظیم شخصی؛ تغییرش در سطح مدیر دفتر.
  if (normalizedPath === '/automation-policy') return 'manager';
  // ورود کدینگ و ماندهٔ افتتاحیه ساختار دفتر را عوض می‌کند؛ الگوی خالی برای همه.
  if (normalizedPath === '/import/template') return 'viewer';
  if (normalizedPath.startsWith('/import/')) return 'manager';
  if (normalizedPath.startsWith('/tax/rates')) return 'manager';
  // طلب استرداد مانده‌ها را میان سه حساب مالیاتی جابه‌جا می‌کند؛ هم‌سطح رابط.
  if (normalizedPath === '/tax/vat-refund-claim') return 'manager';
  // منبع قانونی، دادهٔ پایهٔ دفتر است نه ثبت روزانه؛ ورود و انتشارش کار مدیر است.
  if (normalizedPath.startsWith('/tax-knowledge/')) return 'manager';
  if (normalizedPath.startsWith('/tax-assistant/sources') && !['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return 'manager';
  if (normalizedPath.startsWith('/tax-assistant/questions/') && normalizedPath.endsWith('/resolve')) return 'manager';
  if (normalizedPath.startsWith('/tax-assistant/')) return 'viewer';
  if (normalizedPath === '/backups/restore' || normalizedPath === '/backups/preview') return 'owner';
  if (normalizedPath.startsWith('/backups/')) return 'manager';
  if (normalizedPath === '/settings' || normalizedPath.startsWith('/accounts')) return 'manager';
  return 'accountant';
}
