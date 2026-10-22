// کمک‌های مشترکِ server/index.js و فایل‌های مسیر: کوکی نشست، دسترسی، نقش و محدودیت بارگذاری.

import multer from 'multer';
import { listUserWorkspaces, automationPolicy, scheduleShadowUnderstanding, workspaceForUser } from '../db.js';
import { roleAllows } from '../access.js';
import { EXPERIENCES, experienceForRole, screensFor } from '../../shared/experience.js';

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
export const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
export const statementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
export const chartUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
// الگوی انتقال پارسیان یک دیتابیس Access کامل است و چند مگابایت می‌شود.
export const transferTemplateUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024, files: 1 } });
// بکاپ SQL Server پارسیان هم چند تا چند ده مگابایت است.
export const parsianBackupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

export function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

export function sessionCookie(token, maxAge = 7 * 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `hy_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Priority=High; Max-Age=${maxAge}${secure}`;
}

export function workspaceCookie(workspaceId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `hy_workspace=${encodeURIComponent(workspaceId)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}${secure}`;
}

export function accessPayload(user, requestedWorkspaceId = '') {
  const workspaces = listUserWorkspaces(user.id);
  const workspace = workspaceForUser(user.id, requestedWorkspaceId) || workspaces[0] || null;
  const experience = workspace ? experienceForRole(workspace.role, workspace.experiencePreference) : EXPERIENCES.SIMPLE;
  return {
    user: { id: user.id, username: user.username, displayName: user.displayName || user.username, mustChangePassword: Boolean(user.mustChangePassword), isSystemAdmin: user.username === String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase() },
    workspaces: workspaces.map((item) => ({ ...item, experience: experienceForRole(item.role, item.experiencePreference) })),
    workspace: workspace ? { ...workspace, experience } : null,
    experience,
    // ناوبری از همین‌جا می‌آید تا فرانت‌اند فهرست موازی نسازد؛ یک منبع تصمیم
    // برای هر دو طرف، و همان قاعده‌ای که دروازهٔ بالا با آن کار می‌کند.
    screens: workspace ? screensFor({ role: workspace.role, experience, profileType: workspace.profileType }) : [],
  };
}

export function requireSystemAdmin(request, response) {
  if (request.user?.username === String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase()) return true;
  response.status(403).json({ code: 'SYSTEM_ADMIN_REQUIRED', message: 'این بخش فقط برای مدیر پایلوت حساب‌یار در دسترس است.' });
  return false;
}

export function requireRank(request, response, minimum) {
  if (roleAllows(request.workspace?.role, minimum)) return true;
  response.status(403).json({ code: 'ROLE_FORBIDDEN', message: 'نقش فعلی برای انجام این کار اجازه ندارد.' });
  return false;
}

/**
 * فهم رویداد در حالت مقایسه‌ای: پس از ثبتِ مسیر قدیمی و بی‌اثر بر پاسخ کاربر.
 * شکستش فقط در خود پرونده می‌ماند؛ هیچ استثنایی به این درخواست برنمی‌گردد.
 */
export function shadowUnderstanding(transcript, source, legacy, clientId) {
  try {
    if (!transcript || automationPolicy().understandingMode !== 'shadow') return;
    scheduleShadowUnderstanding({ text: transcript, source, legacy: legacy(), clientId });
  } catch (error) { console.error('shadow understanding failed', error?.code || error?.message); }
}
