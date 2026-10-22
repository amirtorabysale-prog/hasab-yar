// صفحهٔ آغاز، میز کار دفتر، گزارش‌ها و وضعیت دفتر.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  allWorkspaces, answerFinancialQuestion, commercialStatus, financialDnaOverview, financialOverview, getCategories, getLearnings, getSettings, getToday, listAccounts, listContacts, listDailyClosings, listObligations, previewDayClosing, listRecurringRules, materializeRecurringRules, pilotPortfolio, pilotWorkspaceDashboard, dnaProfiles, automationPolicy, firmPortfolio, report, savePilotCheckin, saveSettings, snoozeFinancialAlert, typicalAmounts, updateWorkspaceCommercialPlan, workspaceOperationalSignals,
} from '../db.js';
import { understandingProvider } from '../eventUnderstandingAi.js';
import { automaticBackupStatus } from '../backup.js';
import { accessPayload, requireSystemAdmin } from './http.js';

export function registerHomeRoutes(app) {
  // DNA مالی پرونده: اثر انگشت رفتاری و پروفایل یک‌نگاهی برای دفتر.
  app.get('/api/financial-dna', (request, response, next) => {
    try { return response.json(financialDnaOverview({ months: Number(request.query.months) || 6 })); }
    catch (error) { return next(error); }
  });
  // میز کار دفتر حسابداری. فقط پرونده‌هایی که همین کاربر عضوشان است دیده می‌شوند.
  app.get('/api/firm/portfolio', (request, response, next) => {
    try {
      return response.json(firmPortfolio(request.user.id, {
        month: request.query.month || '',
        refresh: request.query.refresh === '1' || request.query.refresh === 'true',
      }));
    } catch (error) { return next(error); }
  });
  /**
   * دفتر، بدون تحلیل‌هایی که می‌توانند یک لحظه دیرتر برسند.
   *
   * این اولین درخواست بعد از ورود است، پس طولش همان مدتی است که کاربر به یک
   * صفحهٔ نیمه‌خالی نگاه می‌کند. با یک دفتر ششصدثبتی — که برای یک دفتر
   * حسابداری کوچک است — کل پاسخ ۲۴۹ میلی‌ثانیه طول می‌کشید و اندازه‌گیری
   * تک‌تک اجزا نشان داد ۹۹٪ آن فقط در دو تابع است: `financialOverview` با
   * ۱۲۳ms و `dnaProfiles` با ۹۱ms. دوازده تابع دیگر روی هم سه میلی‌ثانیه
   * بودند.
   *
   * هر دو هم تحلیل‌اند نه دادهٔ دفتر، و هر دو با بزرگ‌شدن دفتر بدتر می‌شوند
   * چون همهٔ ردیف‌ها را در JavaScript می‌خوانند. حالا در `/api/insights`
   * جدا شده‌اند و رابط بعد از نمایش دفتر آن‌ها را می‌گیرد. حالت خالی از قبل
   * پشتیبانی می‌شد — `overview: {}` و `dnaProfiles: null` مقدار اولیهٔ
   * همیشگی رابط بوده‌اند — پس چیزی برای شکستن نیست.
   */
  app.get('/api/bootstrap', (request, response) => {
    materializeRecurringRules();
    return response.json({
      ...getToday(), categories: getCategories(), settings: getSettings(), learnings: getLearnings(),
      averages: typicalAmounts(), accounts: listAccounts(), contacts: listContacts(),
      obligations: listObligations({ status: 'open' }), recurring: listRecurringRules(), closings: listDailyClosings(), closingPreview: previewDayClosing(), access: accessPayload(request.user, request.workspace.id),
      // رابط با همین تصمیم می‌گیرد گفتهٔ مرکب به برگهٔ پرونده برود یا مسیر قدیمی.
      understanding: (() => { const policy = automationPolicy(); return { mode: policy.understandingMode, scope: policy.understandingScope, engineV2: policy.engineV2, available: Boolean(understandingProvider()) }; })(),
    });
  });
  app.get('/api/insights', (_request, response) => response.json({ overview: financialOverview(), dnaProfiles: dnaProfiles() }));
  app.get('/api/reports', (request, response) => response.json(report(['week', 'month', 'quarter'].includes(request.query.range) ? request.query.range : 'month')));
  app.get('/api/overview', (_request, response) => response.json(financialOverview()));
  app.post('/api/alerts/:id/snooze', (request, response, next) => { try { return response.json({ item: snoozeFinancialAlert(request.params.id, request.body || {}) }); } catch (error) { return next(error); } });
  app.post('/api/ask', (request, response) => response.json(answerFinancialQuestion(request.body?.question)));
  app.get('/api/commercial/status', (request, response) => response.json(commercialStatus(request.workspace.id)));
  app.post('/api/commercial/admin/workspaces/:workspaceId', (request, response, next) => {
    try {
      if (!requireSystemAdmin(request, response)) return undefined;
      const workspace = allWorkspaces().find((item) => item.id === request.params.workspaceId);
      if (!workspace) return response.status(404).json({ message: 'دفتر پیدا نشد.' });
      const item = updateWorkspaceCommercialPlan(workspace.id, request.body || {}, request.user.id);
      return response.json({ item });
    } catch (error) { return next(error); }
  });
  app.post('/api/pilot/checkins', (request, response, next) => {
    try { return response.status(201).json({ item: savePilotCheckin(request.body || {}), dashboard: pilotWorkspaceDashboard() }); }
    catch (error) { return next(error); }
  });
  app.get('/api/pilot/portfolio', (request, response) => {
    if (!requireSystemAdmin(request, response)) return undefined;
    return response.json(pilotPortfolio());
  });
  app.get('/api/operations/overview', async (request, response, next) => {
    try {
      const backup = await automaticBackupStatus(request.workspace.id);
      const commercial = commercialStatus(request.workspace.id);
      const signals = workspaceOperationalSignals();
      const ageHours = backup.lastBackup ? (Date.now() - new Date(backup.lastBackup.createdAt).getTime()) / 3_600_000 : null;
      return response.json({
        ...signals,
        backup: { ...backup, ageHours: ageHours == null ? null : Math.round(ageHours), healthy: Boolean(backup.configured && ageHours != null && ageHours <= 30) },
        budget: commercial.provider,
        runbook: 'docs/phase-6-pilot-and-operations.md',
      });
    } catch (error) { return next(error); }
  });
  app.patch('/api/settings', (request, response) => response.json({ settings: saveSettings(request.body || {}) }));
}
