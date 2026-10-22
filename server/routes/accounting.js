// دفتر کل: سند، تراز، دوره، تأییدها، دارایی ثابت و قراردادهای دوره‌دار.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  activeWorkspaceDatabase, getSettings, fixedAssetOverview, saveFixedAsset, postDepreciation, reviewAssistantForJournal, runRecognition, timingContracts, seeRecognitionNotice, unscheduledBalances, unscheduledBalancesForEntry, createJournalDocuments, deleteJournalTemplate, journalOverview, journalWorklistOverview, listJournalTemplates, saveJournalTemplate, submitJournalApproval, recordAudit, cancelApprovalRequest, createApprovalRequest, decideApprovalRequest, listApprovalRequests,
} from '../db.js';
import {
  accountingPeriods, createAdjustingJournal, listLedgerAccounts, lockAccountingPeriod, periodForDate, reopenAccountingPeriod, trialBalance,
} from '../accounting.js';

export function registerAccountingRoutes(app) {
  app.get('/api/accounting/accounts', (_request, response) => response.json({ items: listLedgerAccounts(activeWorkspaceDatabase()) }));
  app.get('/api/accounting/trial-balance', (request, response, next) => {
    try { return response.json(trialBalance(activeWorkspaceDatabase(), request.query.through)); }
    catch (error) { return next(error); }
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
