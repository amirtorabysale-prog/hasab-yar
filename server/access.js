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
  if (normalizedPath.startsWith('/accountant-transfer/')) return 'accountant';
  // میز کار دفتر: خروجی به عضویت‌های خود کاربر محدود است، پس نقش دفتر فعال آن را محدود نمی‌کند.
  if (normalizedPath.startsWith('/firm/')) return 'viewer';
  if (normalizedPath.startsWith('/pilot/')) return 'manager';
  if (normalizedPath.startsWith('/operations/')) return 'manager';
  if (normalizedPath.startsWith('/commercial/admin/')) return 'owner';
  if (normalizedPath === '/commercial/status') return 'viewer';
  if (['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return normalizedPath.startsWith('/backups/') ? 'manager' : 'viewer';
  if (normalizedPath.startsWith('/auth/') || normalizedPath.startsWith('/alerts/') || (normalizedPath === '/workspaces' && normalizedMethod === 'POST') || normalizedPath === '/ask') return 'viewer';
  if (normalizedPath.startsWith('/workspace/members')) return 'owner';
  if (normalizedPath.startsWith('/accounting/periods/')) return 'owner';
  if (normalizedPath.startsWith('/reconciliation/imports/') && normalizedPath.endsWith('/close')) return 'manager';
  // کدینگ، تفصیلی و مرکز هزینه دادهٔ پایهٔ دفترند، نه ثبت روزانه؛ تغییرشان در سطح تنظیمات است.
  if (normalizedPath.startsWith('/chart/')) return 'manager';
  if (normalizedPath.startsWith('/tax/rates')) return 'manager';
  if (normalizedPath === '/backups/restore' || normalizedPath === '/backups/preview') return 'owner';
  if (normalizedPath.startsWith('/backups/')) return 'manager';
  if (normalizedPath === '/settings' || normalizedPath.startsWith('/accounts')) return 'manager';
  return 'accountant';
}
