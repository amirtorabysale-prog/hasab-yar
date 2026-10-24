// کدینگ، ورود از اکسل و بکاپ پارسیان، برچسب‌های موضوعی.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  activeWorkspaceDatabase, applyChartSuggestions, chartOverview, dimensionReport, importChart, installChartTemplate, importAnalyticsFile, importChartFile, importOpeningBalanceFile, importTemplateWorkbook, attachCounterpartyAnalytics, clearChartMappings, mapLedgerAccount, mapLedgerAccountsInBulk, saveAnalytic, saveChartAccountEntry, saveCostCenterEntry, saveAccountingTransferSettings,
} from '../db.js';
import { commitParsianBackup, previewParsianBackup } from '../parsianImport.js';
import { commitParsianPhaseB, previewParsianPhaseB } from '../parsianPhaseB.js';
import {
  topicLabelStats, listTopicPromotions, decideTopicPromotion, saveTopicPromotionThreshold, topicPromotionThreshold,
} from '../topicPromotion.js';
import { db as activeDb, currentTimeZone } from '../db/core.js';
import { chartUpload, parsianBackupUpload } from './http.js';

export function registerChartRoutes(app) {
  // فاز ۲ — کدینگ دفتر، تفصیلی شناور و مرکز هزینه.
  app.get('/api/chart/overview', (_request, response, next) => {
    try { return response.json(chartOverview()); } catch (error) { return next(error); }
  });
  app.post('/api/chart/template', (request, response, next) => {
    try { return response.status(201).json(installChartTemplate()); } catch (error) { return next(error); }
  });
  // ورود داده از اکسل و پارسیان. تشخیص xlsx یا CSV از روی بایت فایل است، نه پسوند.
  app.get('/api/import/template', (_request, response, next) => {
    try {
      response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      response.setHeader('Content-Disposition', 'attachment; filename="hesab-yar-import-templates.xlsx"');
      return response.send(importTemplateWorkbook());
    } catch (error) { return next(error); }
  });
  app.post('/api/import/chart', chartUpload.single('file'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
      return response.status(201).json(importChartFile(request.file.buffer, request.file.originalname, {
        replace: request.body?.replace === 'true' || request.body?.replace === true,
      }));
    } catch (error) { return next(error); }
  });
  app.post('/api/import/analytics', chartUpload.single('file'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
      return response.status(201).json(importAnalyticsFile(request.file.buffer, request.file.originalname));
    } catch (error) { return next(error); }
  });
  app.post('/api/import/opening-balances', chartUpload.single('file'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
      return response.status(201).json(importOpeningBalanceFile(request.file.buffer, request.file.originalname, {
        amountUnit: request.body?.amountUnit,
        replace: request.body?.replace === 'true' || request.body?.replace === true,
        occurredAt: request.body?.occurredAt || '',
      }));
    } catch (error) { return next(error); }
  });
  // ورود بکاپ پارسیان: پیش‌نمایش هیچ چیزی نمی‌نویسد؛ ثبت فقط در دفتر خام مجاز است.
  app.post('/api/import/parsian-backup/preview', parsianBackupUpload.single('file'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
      return response.json(previewParsianBackup(activeWorkspaceDatabase(), request.file.buffer, request.file.originalname, {
        amountUnit: request.body?.amountUnit, kolTypes: request.body?.kolTypes,
      }));
    } catch (error) { return next(error); }
  });
  app.post('/api/import/parsian-backup/commit', parsianBackupUpload.single('file'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
      const result = commitParsianBackup(activeWorkspaceDatabase(), request.file.buffer, request.file.originalname, {
        createdBy: request.user?.id || null, timeZone: currentTimeZone(),
        amountUnit: request.body?.amountUnit, kolTypes: request.body?.kolTypes,
      });
      // واحدی که دفتر برای مبلغ‌های پارسیانش گفت، همان واحد فایل انتقال به پارسیان
      // است؛ بدون این، خروجی برگشتی با پیش‌فرض تومان ده برابر کوچک‌تر درمی‌آمد.
      saveAccountingTransferSettings({ targetSystem: 'parsian-review-csv', amountUnit: result.amountUnit });
      return response.status(201).json(result);
    } catch (error) { return next(error); }
  });
  // فاز ب: ساخت حساب‌های عملیاتی و اشخاص از کدینگِ واردشده — بدون هیچ سند تازه.
  app.get('/api/import/parsian-backup/phase-b', (_request, response, next) => {
    try { return response.json(previewParsianPhaseB(activeWorkspaceDatabase())); } catch (error) { return next(error); }
  });
  app.post('/api/import/parsian-backup/phase-b', (request, response, next) => {
    try {
      return response.json(commitParsianPhaseB(activeWorkspaceDatabase(), {
        contactIds: request.body?.contactIds, createdBy: request.user?.id || null,
      }));
    } catch (error) { return next(error); }
  });
  app.post('/api/chart/import', chartUpload.single('chart'), (request, response, next) => {
    try {
      const text = request.file ? request.file.buffer.toString('utf8') : String(request.body?.csv || '');
      if (!text.trim()) return response.status(400).json({ code: 'CHART_FILE_EMPTY', message: 'فایل کدینگ خالی است.' });
      return response.status(201).json(importChart(text, { replace: request.body?.replace === 'true' || request.body?.replace === true }));
    } catch (error) { return next(error); }
  });
  app.post('/api/chart/accounts', (request, response, next) => {
    try { return response.status(201).json({ item: saveChartAccountEntry(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.put('/api/chart/accounts/:id', (request, response, next) => {
    try { return response.json({ item: saveChartAccountEntry({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
  });
  app.put('/api/chart/mappings/:ledgerAccountId', (request, response, next) => {
    try { return response.json(mapLedgerAccount(request.params.ledgerAccountId, request.body?.chartAccountId || null)); } catch (error) { return next(error); }
  });
  app.post('/api/chart/analytics/attach', (request, response, next) => {
    try { return response.json(attachCounterpartyAnalytics()); } catch (error) { return next(error); }
  });
  app.post('/api/chart/mappings/bulk', (request, response, next) => {
    try {
      return response.json(mapLedgerAccountsInBulk(request.body?.ledgerAccountIds || [], request.body?.chartAccountId || null));
    } catch (error) { return next(error); }
  });
  app.delete('/api/chart/mappings', (request, response, next) => {
    try { return response.json(clearChartMappings()); } catch (error) { return next(error); }
  });
  app.post('/api/chart/mappings/suggest', (request, response, next) => {
    try { return response.json(applyChartSuggestions({ refine: request.body?.refine === true })); } catch (error) { return next(error); }
  });
  app.get('/api/chart/dimensions/balance', (request, response, next) => {
    try { return response.json(dimensionReport(request.query)); } catch (error) { return next(error); }
  });
  app.post('/api/chart/analytics', (request, response, next) => {
    try { return response.status(201).json({ item: saveAnalytic(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.put('/api/chart/analytics/:id', (request, response, next) => {
    try { return response.json({ item: saveAnalytic({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
  });
  app.post('/api/chart/cost-centers', (request, response, next) => {
    try { return response.status(201).json({ item: saveCostCenterEntry(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.put('/api/chart/cost-centers/:id', (request, response, next) => {
    try { return response.json({ item: saveCostCenterEntry({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
  });
  // موتور برچسب موضوعی (طرح ترکیبی): شمارش، پیشنهاد ارتقا و تصمیم حسابدار. گشتِ
  // پیشنهاد در کار دقیقه‌ای است، نه در خواندن صفحه: دیدنِ صف، حتی با نقش «فقط مشاهده»،
  // چیزی در دفتر نمی‌نویسد و برچسبی که کسی صفحه‌اش را باز نکرده هم پیشنهاد می‌شود.
  app.get('/api/topics/overview', (request, response, next) => {
    try {
      return response.json({ ...topicLabelStats(activeDb, { timeZone: currentTimeZone() }), promotions: listTopicPromotions(activeDb) });
    } catch (error) { return next(error); }
  });
  app.post('/api/topics/promotions/:id/decide', (request, response, next) => {
    try { return response.json({ item: decideTopicPromotion(activeDb, request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/topics/threshold', (request, response, next) => {
    try { return response.json({ threshold: saveTopicPromotionThreshold(request.body?.threshold) }); } catch (error) { return next(error); }
  });
  app.get('/api/topics/threshold', (_request, response) => response.json({ threshold: topicPromotionThreshold(activeDb) }));
}
