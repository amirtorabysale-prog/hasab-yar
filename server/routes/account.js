// ورود، نشست‌ها، دفترها و اعضا.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  addWorkspaceMember, changePassword, createWorkspace, deleteSession, listUserSessions, listUserWorkspaces, listWorkspaceMembers, setExperiencePreference, archiveWorkspace, listArchivedWorkspaces, renameWorkspace, restoreArchivedWorkspace, removeWorkspaceMember, revokeOtherUserSessions, revokeUserSession, updateWorkspaceMember,
} from '../db.js';
import { EXPERIENCES, canChooseExperience } from '../../shared/experience.js';
import { automaticBackupConfigured, writeServerBackup } from '../backup.js';
import { sessionCookie, accessPayload, requireRank } from './http.js';

export function registerAccountRoutes(app) {
  app.post('/api/auth/logout', (request, response) => {
    deleteSession(request.sessionToken);
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return response.status(204).end();
  });
  app.post('/api/auth/password', (request, response) => {
    const result = changePassword(request.user.id, request.body?.currentPassword, request.body?.newPassword);
    if (!result.changed) {
      const status = result.code === 'CURRENT_PASSWORD_INVALID' ? 401 : 400;
      return response.status(status).json({ code: result.code, message: result.message || 'رمز فعلی درست نیست.' });
    }
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return response.status(204).end();
  });
  app.get('/api/auth/sessions', (request, response) => {
    return response.json({ items: listUserSessions(request.user.id, request.sessionToken) });
  });
  app.delete('/api/auth/sessions/:sessionId', (request, response) => {
    const result = revokeUserSession(request.user.id, request.params.sessionId, request.sessionToken);
    if (result.revoked) return response.status(204).end();
    const current = result.code === 'CURRENT_SESSION';
    return response.status(current ? 400 : 404).json({
      code: result.code,
      message: current ? 'نشست فعلی را از مسیر خروج امن ببند.' : 'نشست پیدا نشد یا قبلاً بسته شده است.',
    });
  });
  app.post('/api/auth/sessions/revoke-others', (request, response) => {
    return response.json(revokeOtherUserSessions(request.user.id, request.sessionToken));
  });
  app.get('/api/workspaces', (request, response) => response.json(accessPayload(request.user, request.workspace.id)));
  app.post('/api/workspaces', (request, response, next) => {
    try {
      const workspace = createWorkspace(request.user.id, request.body || {});
      return response.status(201).json({ workspace, workspaces: listUserWorkspaces(request.user.id) });
    } catch (error) { error.status ||= 400; return next(error); }
  });
  // بایگانی و نام دفتر — فقط مالک همان دفتر، هرکدام که دفتر فعال باشد.
  app.get('/api/workspaces/archived', (request, response) => response.json({ items: listArchivedWorkspaces(request.user.id) }));
  app.put('/api/workspaces/:id', (request, response, next) => {
    try { renameWorkspace(request.user.id, request.params.id, request.body?.name); return response.json(accessPayload(request.user, request.workspace.id)); }
    catch (error) { return next(error); }
  });
  app.post('/api/workspaces/:id/archive', async (request, response, next) => {
    try {
      const target = listUserWorkspaces(request.user.id).find((item) => item.id === request.params.id);
      if (!target) return response.status(404).json({ code: 'WORKSPACE_NOT_FOUND', message: 'دفتر فعال پیدا نشد.' });
      if (target.role !== 'owner') return response.status(403).json({ code: 'WORKSPACE_OWNER_REQUIRED', message: 'فقط مالک دفتر می‌تواند آن را بایگانی کند.' });
      // پشتیبان رمزشده پیش از بایگانی؛ اگر پیکربندی نشده، فایل داده همچنان دست‌نخورده می‌ماند.
      const backup = automaticBackupConfigured() ? await writeServerBackup(target, { reason: 'archive' }) : null;
      const item = archiveWorkspace(request.user.id, target.id);
      const nextWorkspace = request.workspace.id === target.id ? listUserWorkspaces(request.user.id)[0]?.id : request.workspace.id;
      return response.json({ item, backup, ...accessPayload(request.user, nextWorkspace) });
    } catch (error) { return next(error); }
  });
  app.post('/api/workspaces/:id/restore', (request, response, next) => {
    try { const item = restoreArchivedWorkspace(request.user.id, request.params.id); return response.json({ item, ...accessPayload(request.user, request.workspace.id) }); }
    catch (error) { return next(error); }
  });
  app.get('/api/workspace/members', (request, response) => {
    if (!requireRank(request, response, 'manager')) return undefined;
    return response.json({ items: listWorkspaceMembers(request.workspace.id) });
  });
  app.post('/api/workspace/members', (request, response, next) => {
    try { return response.status(201).json({ item: addWorkspaceMember(request.workspace.id, request.body || {}) }); }
    catch (error) { error.status ||= 400; return next(error); }
  });
  // انتخاب محیط ساده یا حرفه‌ای.
  //
  // مالک به‌طور پیش‌فرض در محیط ساده است؛ بدون این مسیر هیچ راهی برای رسیدن به
  // ابزار حسابدار — از جمله خروجی پارسیان — نداشت، مگر اینکه همان کاربرِ
  // ADMIN_USERNAME روی سرور باشد. عمداً بیرون از مرز حرفه‌ای است: کسی که در
  // محیط ساده گیر افتاده باید بتواند از آن بیرون بیاید.
  app.put('/api/workspace/experience', (request, response) => {
    const preference = request.body?.experience;
    if (!canChooseExperience(request.workspace.role)) {
      return response.status(403).json({ code: 'EXPERIENCE_FIXED', message: 'محیط این نقش ثابت است و قابل تغییر نیست.' });
    }
    if (!Object.values(EXPERIENCES).includes(preference)) {
      return response.status(400).json({ code: 'EXPERIENCE_INVALID', message: 'محیط انتخاب‌شده معتبر نیست.' });
    }
    setExperiencePreference(request.workspace.id, request.user.id, preference);
    return response.json(accessPayload(request.user, request.workspace.id));
  });
  app.put('/api/workspace/members/:userId', (request, response, next) => {
    try {
      const item = updateWorkspaceMember(request.workspace.id, request.params.userId, request.body?.role);
      return item ? response.json({ item }) : response.status(404).json({ message: 'عضو پیدا نشد.' });
    } catch (error) { error.status ||= 400; return next(error); }
  });
  app.delete('/api/workspace/members/:userId', (request, response, next) => {
    try { return response.status(removeWorkspaceMember(request.workspace.id, request.params.userId) ? 204 : 404).end(); }
    catch (error) { error.status ||= 400; return next(error); }
  });
}
