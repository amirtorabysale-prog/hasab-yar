// دفتر کل: سند، تراز، دوره، تأییدها، دارایی ثابت و قراردادهای دوره‌دار.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  activeWorkspaceDatabase, getSettings, fixedAssetOverview, saveFixedAsset, postDepreciation, reviewAssistantForJournal, runRecognition, timingContracts, seeRecognitionNotice, unscheduledBalances, unscheduledBalancesForEntry, createJournalDocuments, deleteJournalTemplate, journalOverview, journalWorklistOverview, listJournalTemplates, saveJournalTemplate, submitJournalApproval, recordAudit, cancelApprovalRequest, createApprovalRequest, decideApprovalRequest, listApprovalRequests,
} from '../db.js';
import {
  accountingPeriods, closeFiscalYear, createAdjustingJournal, fiscalYearClosings, listLedgerAccounts, lockAccountingPeriod, periodForDate, previewYearClose, reopenAccountingPeriod, reopenFiscalYear, setFiscalYearStartMonth, trialBalance,
} from '../accounting.js';
import {
  accountLedgerReport, agingReport, balanceSheetReport, cashFlowReport, costCenterReport, equityChangesReport, incomeStatementReport,
  journalBookReport, ledgerControlsReport, ledgerYears, personsReport, reportSheets, trialBalanceReport,
} from '../accounting/reports.js';
import { approveImportedEntries, importedEntriesOverview } from '../db.js';
import { previewInventoryClose, proposeInventoryClose } from '../accounting/inventoryClose.js';
import { requireRank } from './http.js';
import { buildWorkbook } from '../spreadsheet.js';

// گزارش‌های حسابداری: هر نام یک تابعِ خالص روی دفتر فعال است. پارامترها همان رشته‌های
// پرس‌وجو هستند؛ اعتبارسنجی تاریخ و سطح درون خودِ گزارش است.
const REPORTS = Object.freeze({
  trial: (db, query, timeZone) => trialBalanceReport(db, { from: query.from, to: query.to, level: query.level || 'subsidiary', includeZero: query.includeZero === '1', includeDrafts: query.drafts === '1', beforeClose: query.beforeClose === '1', timeZone }),
  ledger: (db, query, timeZone) => accountLedgerReport(db, { from: query.from, to: query.to, level: query.level || 'subsidiary', key: query.key, analyticId: query.analyticId, includeDrafts: query.drafts === '1', beforeClose: query.beforeClose === '1', timeZone }),
  journal: (db, query, timeZone) => journalBookReport(db, { from: query.from, to: query.to, includeDrafts: query.drafts === '1', timeZone }),
  'income-statement': (db, query, timeZone) => incomeStatementReport(db, { from: query.from, to: query.to, compare: query.compare === '1', includeDrafts: query.drafts === '1', timeZone }),
  'balance-sheet': (db, query, timeZone) => balanceSheetReport(db, { to: query.to, compare: query.compare === '1', includeDrafts: query.drafts === '1', timeZone }),
  'cash-flow': (db, query, timeZone) => cashFlowReport(db, { from: query.from, to: query.to, includeDrafts: query.drafts === '1', timeZone }),
  'equity-changes': (db, query, timeZone) => equityChangesReport(db, { from: query.from, to: query.to, includeDrafts: query.drafts === '1', timeZone }),
  persons: (db, query, timeZone) => personsReport(db, { to: query.to, includeDrafts: query.drafts === '1', timeZone }),
  aging: (db, query, timeZone) => agingReport(db, { includeDrafts: query.drafts === '1', timeZone }),
  'cost-centers': (db, query, timeZone) => costCenterReport(db, { from: query.from, to: query.to, includeDrafts: query.drafts === '1', timeZone }),
  controls: (db, query, timeZone) => ledgerControlsReport(db, { to: query.to, includeDrafts: query.drafts === '1', timeZone }),
});
const REPORT_TITLES = Object.freeze({
  trial: 'تراز آزمایشی', ledger: 'دفتر حساب', journal: 'دفتر روزنامه', 'income-statement': 'صورت سود و زیان', 'balance-sheet': 'ترازنامه',
  'cash-flow': 'جریان وجوه نقد', 'equity-changes': 'تغییرات حقوق مالکانه', persons: 'مانده اشخاص', aging: 'گزارش سنی', 'cost-centers': 'مراکز هزینه', controls: 'کنترل‌های دفتر',
});

export function registerAccountingRoutes(app) {
  app.get('/api/accounting/accounts', (_request, response) => response.json({ items: listLedgerAccounts(activeWorkspaceDatabase()) }));
  app.get('/api/accounting/trial-balance', (request, response, next) => {
    try { return response.json(trialBalance(activeWorkspaceDatabase(), request.query.through)); }
    catch (error) { return next(error); }
  });
  app.get('/api/accounting/reports/years', (_request, response, next) => {
    try { return response.json(ledgerYears(activeWorkspaceDatabase(), { timeZone: getSettings().timezone || 'Asia/Tehran' })); }
    catch (error) { return next(error); }
  });
  // ورودهای بکاپ پارسیان و تأیید یک‌جای سندهای سالمشان؛ کنترل‌کننده (مدیر به بالا).
  app.get('/api/accounting/imports', (_request, response, next) => {
    try { return response.json(importedEntriesOverview()); } catch (error) { return next(error); }
  });
  app.post('/api/accounting/imports/:sha/approve', (request, response, next) => {
    if (!requireRank(request, response, 'manager')) return undefined;
    try { return response.json(approveImportedEntries({ fileSha256: request.params.sha })); } catch (error) { return next(error); }
  });
  app.get('/api/accounting/reports/:kind', (request, response, next) => {
    const build = REPORTS[request.params.kind];
    if (!build) return response.status(404).json({ code: 'REPORT_UNKNOWN', message: 'این گزارش وجود ندارد.' });
    try { return response.json(build(activeWorkspaceDatabase(), request.query, getSettings().timezone || 'Asia/Tehran')); }
    catch (error) { return next(error); }
  });
  app.get('/api/accounting/reports/:kind/export', (request, response, next) => {
    const build = REPORTS[request.params.kind];
    if (!build) return response.status(404).json({ code: 'REPORT_UNKNOWN', message: 'این گزارش وجود ندارد.' });
    try {
      const report = build(activeWorkspaceDatabase(), request.query, getSettings().timezone || 'Asia/Tehran');
      // گزارشِ با پیش‌نویس‌ها در نام فایل و شیت هم «غیرقطعی» است.
      const title = `${report.provisional ? 'غیرقطعی - ' : ''}${REPORT_TITLES[request.params.kind]}`;
      const workbook = buildWorkbook(reportSheets(report, { columns: Number(request.query.columns) || 4, title }));
      response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      response.setHeader('Content-Disposition', `attachment; filename="hesab-yar-${request.params.kind}.xlsx"; filename*=UTF-8''${encodeURIComponent(title)}.xlsx`);
      return response.send(workbook);
    } catch (error) { return next(error); }
  });
  app.get('/api/accounting/journal', (request, response) => response.json(journalOverview(request.query)));
  app.post('/api/accounting/journal', (request, response, next) => {
    try {
      const item = createAdjustingJournal(activeWorkspaceDatabase(), request.body || {}, { createdBy: request.user.id, timeZone: getSettings().timezone });
      recordAudit('create', 'adjusting_journal', item.id, { memo: request.body?.memo });
      return response.status(201).json({ item });
    } catch (error) { return next(error); }
  });
  // فاز ۳ — ثبت انبوه، کارتابل تأیید و الگوی سند.
  app.post('/api/accounting/journal/batch', (request, response, next) => {
    try { return response.status(201).json(createJournalDocuments(request.body?.documents)); }
    catch (error) { return next(error); }
  });
  app.get('/api/approval-requests', (request, response) => response.json({ items: listApprovalRequests({ status: String(request.query.status || 'open') }) }));
  app.post('/api/approval-requests', (request, response) => response.status(201).json(createApprovalRequest(request.body || {})));
  app.post('/api/approval-requests/:id/decide', (request, response) => response.json(decideApprovalRequest(request.params.id, request.body || {})));
  app.post('/api/approval-requests/:id/cancel', (request, response) => response.json(cancelApprovalRequest(request.params.id)));
  app.get('/api/accounting/journal/worklist', (request, response, next) => {
    try { return response.json(journalWorklistOverview(request.query)); } catch (error) { return next(error); }
  });
  app.post('/api/accounting/journal/:id/approval', (request, response, next) => {
    try {
      const result = submitJournalApproval(request.params.id, request.body?.state, request.body?.reason || '');
      // سند دستیِ تأییدشده‌ای که پیش‌پرداخت یا درآمد انتقالی ساخت و برنامه ندارد،
      // همین‌جا سؤال دوره را برمی‌گرداند — نه یک سال بعد در تراز.
      if (result?.to !== 'approved') return response.json(result);
      const unscheduled = unscheduledBalancesForEntry(request.params.id);
      return response.json(unscheduled.length ? { ...result, unscheduledTimingBalances: unscheduled } : result);
    }
    catch (error) { return next(error); }
  });
  app.get('/api/accounting/templates', (_request, response, next) => {
    try { return response.json({ items: listJournalTemplates() }); } catch (error) { return next(error); }
  });
  app.post('/api/accounting/templates', (request, response, next) => {
    try { return response.status(201).json({ item: saveJournalTemplate(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.put('/api/accounting/templates/:id', (request, response, next) => {
    try { return response.json({ item: saveJournalTemplate({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
  });
  app.delete('/api/accounting/templates/:id', (request, response) => response.status(deleteJournalTemplate(request.params.id) ? 204 : 404).end());
  app.get('/api/accounting/periods', (_request, response) => response.json({ items: accountingPeriods(activeWorkspaceDatabase()), currentPeriod: periodForDate(new Date(), getSettings().timezone) }));
  app.post('/api/accounting/periods/:period/lock', (request, response, next) => {
    try {
      // شناسایی‌های سررسیدرسیده پیش از بستن ثبت می‌شوند؛ وگرنه بستن دوره آن‌ها را
      // پشت در می‌گذاشت و هزینه یا درآمد همان ماه بی‌صدا از دست می‌رفت.
      runRecognition();
      const item = lockAccountingPeriod(activeWorkspaceDatabase(), request.params.period, request.user.id);
      recordAudit('lock', 'accounting_period', request.params.period, {});
      // ماندهٔ دوره‌دارِ بی‌برنامه بستن را رد نمی‌کند — دوره‌اش معلوم نیست که بگوییم
      // در این ماه سهمی داشت — ولی بی‌صدا هم نمی‌ماند.
      const unscheduled = unscheduledBalances().items;
      return response.json(unscheduled.length ? { item, unscheduledTimingBalances: unscheduled } : { item });
    } catch (error) { return next(error); }
  });
  app.post('/api/accounting/periods/:period/reopen', (request, response, next) => {
    try {
      const item = reopenAccountingPeriod(activeWorkspaceDatabase(), request.params.period, request.user.id, request.body?.reason);
      recordAudit('reopen', 'accounting_period', request.params.period, { reason: request.body?.reason });
      return response.json({ item });
    } catch (error) { return next(error); }
  });
  // بستن سال مالی: پیش‌نمایش برای همه، بستن و بازگشایی فقط مالک (مثل قفل دوره).
  app.get('/api/accounting/year-close', (_request, response, next) => {
    try { return response.json({ items: fiscalYearClosings(activeWorkspaceDatabase()) }); } catch (error) { return next(error); }
  });
  // ماه شروع سال مالی؛ فقط مالک و فقط پیش از بستن اولین سال، قفل دوره یا تحویل به پارسیان.
  app.post('/api/accounting/fiscal-year', (request, response, next) => {
    try {
      const result = setFiscalYearStartMonth(activeWorkspaceDatabase(), request.body?.startMonth, { timeZone: getSettings().timezone || 'Asia/Tehran' });
      if (result.changed) recordAudit('update', 'settings', 'fiscalYearStartMonth', { from: result.previous, to: result.startMonth, renumbered: result.renumbered });
      return response.json(result);
    } catch (error) { return next(error); }
  });
  app.get('/api/accounting/year-close/:year', (request, response, next) => {
    try { return response.json(previewYearClose(activeWorkspaceDatabase(), request.params.year, { timeZone: getSettings().timezone || 'Asia/Tehran', retainedChartAccountId: String(request.query.retained || '') })); }
    catch (error) { return next(error); }
  });
  app.post('/api/accounting/year-close/:year/close', (request, response, next) => {
    try {
      // شناسایی‌های سررسیدرسیده پیش از بستن ثبت می‌شوند؛ همان قاعدهٔ قفل دوره.
      runRecognition();
      const result = closeFiscalYear(activeWorkspaceDatabase(), request.params.year, { userId: request.user.id, timeZone: getSettings().timezone || 'Asia/Tehran', retainedChartAccountId: String(request.body?.retainedChartAccountId || '') });
      recordAudit('close', 'fiscal_year', String(request.params.year), { profit: result.profit, documents: result.documents, imported: result.imported });
      return response.json(result);
    } catch (error) { return next(error); }
  });
  // سند پایان دورهٔ انبار (روش ادواری پارسیان): پیش‌نمایش برای همه، ساخت پیشنهاد «منتظر کنترل» برای مدیر.
  app.get('/api/accounting/inventory-close/:year', (request, response, next) => {
    try { return response.json(previewInventoryClose(activeWorkspaceDatabase(), request.params.year, { timeZone: getSettings().timezone || 'Asia/Tehran', targetLedgerAccountId: String(request.query.target || '') })); }
    catch (error) { return next(error); }
  });
  app.post('/api/accounting/inventory-close/:year', (request, response, next) => {
    try {
      const result = proposeInventoryClose(activeWorkspaceDatabase(), request.params.year, { userId: request.user.id, timeZone: getSettings().timezone || 'Asia/Tehran', targetLedgerAccountId: String(request.body?.targetLedgerAccountId || '') });
      recordAudit(result.rebuilt ? 'update' : 'create', 'inventory_close', String(request.params.year), { entryId: result.entryId, amounts: result.amounts });
      return response.status(result.rebuilt ? 200 : 201).json(result);
    } catch (error) { return next(error); }
  });
  app.post('/api/accounting/year-close/:year/reopen', (request, response, next) => {
    try {
      const result = reopenFiscalYear(activeWorkspaceDatabase(), request.params.year, { userId: request.user.id, reason: request.body?.reason, timeZone: getSettings().timezone || 'Asia/Tehran' });
      recordAudit('reopen', 'fiscal_year', String(request.params.year), { reason: request.body?.reason, reversals: result.reversals });
      return response.json(result);
    } catch (error) { return next(error); }
  });
  app.get('/api/accounting/journal/:id/review-history', (request,response,next) => {
    try { return response.json(reviewAssistantForJournal(request.params.id)); } catch(error) {return next(error);}
  });
  // اقلام شناسایی‌ای که دورهٔ بسته جلویشان را گرفته، و ثبت جبرانیِ تأییدشدهٔ حسابدار.
  // بخش «پیش‌پرداخت و پیش‌دریافت» — بیرون از /financial-events تا مالک در محیط ساده هم ببیند.
  app.get('/api/timing-contracts', (_request, response, next) => {
    try { return response.json(timingContracts()); } catch (error) { return next(error); }
  });
  app.post('/api/timing-contracts/notices/:periodKey/seen', (request, response, next) => {
    try { return response.json(seeRecognitionNotice(request.params.periodKey)); } catch (error) { return next(error); }
  });
  app.get('/api/fixed-assets', (request, response, next) => {
    try { return response.json(fixedAssetOverview({ throughMonth: String(request.query.month || '') })); } catch (error) { return next(error); }
  });
  app.put('/api/fixed-assets/:assetKey', (request, response, next) => {
    try { return response.json({ item: saveFixedAsset({ ...request.body, assetKey: request.params.assetKey }) }); } catch (error) { return next(error); }
  });
  app.post('/api/fixed-assets/depreciation', (request, response, next) => {
    try { return response.json(postDepreciation({ throughMonth: String(request.body?.month || '') })); } catch (error) { return next(error); }
  });
}
