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
  if (['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return normalizedPath.startsWith('/backups/') ? 'manager' : 'viewer';
  if (normalizedPath.startsWith('/auth/') || (normalizedPath === '/workspaces' && normalizedMethod === 'POST') || normalizedPath === '/ask') return 'viewer';
  if (normalizedPath.startsWith('/workspace/members')) return 'owner';
  if (normalizedPath.startsWith('/accounting/periods/')) return 'owner';
  if (normalizedPath.startsWith('/reconciliation/imports/') && normalizedPath.endsWith('/close')) return 'manager';
  if (normalizedPath === '/backups/restore' || normalizedPath === '/backups/preview') return 'owner';
  if (normalizedPath.startsWith('/backups/')) return 'manager';
  if (normalizedPath === '/settings' || normalizedPath.startsWith('/accounts')) return 'manager';
  return 'accountant';
}
