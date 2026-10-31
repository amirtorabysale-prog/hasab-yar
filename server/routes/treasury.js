// بانک و صندوق: حساب‌ها، تنخواه، چک، بستن روز، مغایرت و سرمایه.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  closeBankReconciliation, closeDay, createTransactionFromStatementLine, getReconciliationImport, moneyAccountCard, listAccounts, listDailyClosings, previewDayClosing, importBankStatement, ignoreReconciliationLine, listReconciliationImports, matchReconciliationLine, recordCapitalEntry, bounceCheque, cancelCheque, chequeCalendar, chequeHistory, chequeSummary, clearCheque, depositCheque, resolveReviewCheque, transferCheque, withdrawChequeDeposit, listCheques, recordCheque, transferWithFee, closePettyCashFund, fundPettyCashFromSpeech, listPettyCashFunds, openPettyCashFund, replenishPettyCashFund, updatePettyCashCeiling, saveAccount,
  bankSmsSettings, saveBankSmsSettings, listBankSms, ingestBankSms, assignBankSmsAccount, matchBankSms, recordBankSms, ignoreBankSms, reopenBankSms,
} from '../db.js';
import { statementUpload } from './http.js';
import { activeWorkspaceDatabase } from '../db/core.js';
import { listGuaranteeCheques } from '../parsianSideRecords.js';

export function registerTreasuryRoutes(app) {
  // تسویهٔ دورهٔ ارزش افزوده — از ماندهٔ دفتر، نه دوبارهٔ فاکتورها.
  // انتقال پول میان حساب‌های خودمان — نه درآمد، نه هزینه.
  // تنخواه‌گردان: پرداخت، شارژ و بستن، هر سه انتقال میان حساب‌های خود شرکت‌اند.
  app.get('/api/petty-cash', (request, response) => response.json({ items: listPettyCashFunds({ includeClosed: request.query.closed === '1' }) }));
  app.post('/api/petty-cash', (request, response, next) => {
    try { return response.status(201).json({ item: openPettyCashFund(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/petty-cash/voice', (request, response, next) => {
    try { return response.status(201).json(fundPettyCashFromSpeech(request.body || {})); } catch (error) { return next(error); }
  });
  app.post('/api/petty-cash/:id/replenish', (request, response, next) => {
    try { return response.json({ item: replenishPettyCashFund(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.put('/api/petty-cash/:id', (request, response, next) => {
    try { return response.json({ item: updatePettyCashCeiling(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/petty-cash/:id/close', (request, response, next) => {
    try { return response.json({ item: closePettyCashFund(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/accounts/transfer', (request, response, next) => {
    try { return response.status(201).json({ item: transferWithFee(request.body || {}) }); } catch (error) { return next(error); }
  });
  // چک‌های ضمانتِ بکاپ پارسیان: فقط دیدن؛ سند و مانده ندارند.
  app.get('/api/cheques/guarantees', (_request, response, next) => {
    try { return response.json({ items: listGuaranteeCheques(activeWorkspaceDatabase()) }); } catch (error) { return next(error); }
  });
  // دفتر چک: ثبت، وصول، برگشت.
  app.get('/api/cheques', (request, response, next) => {
    try {
      return response.json({
        items: listCheques({ status: request.query?.status ?? 'open', direction: request.query?.direction }),
        summary: chequeSummary(),
      });
    } catch (error) { return next(error); }
  });
  app.post('/api/cheques', (request, response, next) => {
    try { return response.status(201).json({ item: recordCheque(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/cheques/:id/clear', (request, response, next) => {
    try { return response.json({ item: clearCheque(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/cheques/:id/bounce', (request, response, next) => {
    try { return response.json({ item: bounceCheque(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.get('/api/cheques/calendar', (request, response, next) => {
    try { return response.json(chequeCalendar({ days: request.query?.days })); } catch (error) { return next(error); }
  });
  app.get('/api/cheques/:id/history', (request, response, next) => {
    try { return response.json({ items: chequeHistory(request.params.id) }); } catch (error) { return next(error); }
  });
  // نزد بانک، پس‌گرفتن از بانک، واگذاری و تعیین تکلیف چک «نیازمند بررسی».
  for (const [path, action] of [['deposit', depositCheque], ['withdraw', withdrawChequeDeposit], ['transfer', transferCheque], ['resolve', resolveReviewCheque]]) {
    app.post(`/api/cheques/:id/${path}`, (request, response, next) => {
      try { return response.json({ item: action(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
    });
  }
  app.post('/api/cheques/:id/cancel', (request, response, next) => {
    try { return response.json({ item: cancelCheque(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.get('/api/accounts', (_request, response) => response.json({ items: listAccounts() }));
  // کارت حساب یک بانک، صندوق یا تنخواه: گردشش از دفتر کل با مانده‌گیری تجمعی.
  app.get('/api/accounts/:id/card', (request, response, next) => {
    try {
      return response.json(moneyAccountCard(request.params.id, {
        from: String(request.query.from || '').slice(0, 40),
        to: String(request.query.to || '').slice(0, 40),
      }));
    } catch (error) { return next(error); }
  });
  app.post('/api/accounts', (request, response, next) => { try { response.status(201).json({ item: saveAccount(request.body) }); } catch (error) { next(error); } });
  app.put('/api/accounts/:id', (request, response, next) => { try { response.json({ item: saveAccount({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
  // آورده و دارایی ثابت: پول از صندوق رد می‌شود ولی سود دوره را تکان نمی‌دهد.
  app.post('/api/capital-entries', (request, response, next) => {
    try { return response.status(201).json({ item: recordCapitalEntry(request.body || {}) }); }
    catch (error) { return next(error); }
  });
  app.get('/api/reconciliation/imports', (_request, response) => response.json({ items: listReconciliationImports() }));
  app.get('/api/reconciliation/imports/:id', (request, response) => { const item = getReconciliationImport(request.params.id); return item ? response.json({ item }) : response.status(404).json({ message: 'صورت‌حساب پیدا نشد.' }); });
  app.post('/api/reconciliation/imports', statementUpload.single('statement'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ message: 'فایل CSV صورت‌حساب را انتخاب کن.' });
      if (!/\.csv$/i.test(request.file.originalname || '')) return response.status(400).json({ code: 'STATEMENT_FILE_TYPE', message: 'فقط فایل CSV پذیرفته می‌شود.' });
      const item = importBankStatement({ buffer: request.file.buffer, fileName: request.file.originalname, accountId: request.body?.accountId });
      return response.status(201).json({ item });
    } catch (error) { return next(error); }
  });
  app.post('/api/reconciliation/lines/:id/match', (request, response, next) => { try { return response.json({ item: matchReconciliationLine(request.params.id, request.body?.transactionId) }); } catch (error) { return next(error); } });
  app.post('/api/reconciliation/lines/:id/create', (request, response, next) => { try { const item = createTransactionFromStatementLine(request.params.id, request.body || {}); return item ? response.status(201).json({ item }) : response.status(404).json({ message: 'ردیف باز پیدا نشد.' }); } catch (error) { return next(error); } });
  // پیامک بانکی: تنظیمات (کلی و هر بانک)، ورود پیامک، تطبیق، ثبت و کنار گذاشتن.
  const smsRoute = (handler) => (request, response, next) => { try { return response.json(handler(request)); } catch (error) { return next(error); } };
  app.get('/api/bank-sms/settings', smsRoute(() => ({ settings: bankSmsSettings() })));
  app.put('/api/bank-sms/settings', smsRoute((request) => ({ settings: saveBankSmsSettings(request.body || {}) })));
  app.get('/api/bank-sms', smsRoute((request) => listBankSms({ status: String(request.query.status || '') })));
  app.post('/api/bank-sms', smsRoute((request) => ingestBankSms(request.body?.messages || request.body || [])));
  app.post('/api/bank-sms/:id/account', smsRoute((request) => ({ item: assignBankSmsAccount(request.params.id, request.body?.accountId) })));
  app.post('/api/bank-sms/:id/match', smsRoute((request) => ({ item: matchBankSms(request.params.id, request.body?.transactionId) })));
  app.post('/api/bank-sms/:id/record', smsRoute((request) => ({ item: recordBankSms(request.params.id, request.body || {}) })));
  app.post('/api/bank-sms/:id/ignore', smsRoute((request) => ({ item: ignoreBankSms(request.params.id, request.body?.reason) })));
  app.post('/api/bank-sms/:id/reopen', smsRoute((request) => ({ item: reopenBankSms(request.params.id) })));
  app.post('/api/reconciliation/lines/:id/ignore', (request, response, next) => { try { return response.json({ item: ignoreReconciliationLine(request.params.id, request.body?.reason) }); } catch (error) { return next(error); } });
  app.post('/api/reconciliation/imports/:id/close', (request, response, next) => { try { return response.json({ item: closeBankReconciliation(request.params.id) }); } catch (error) { return next(error); } });
  app.get('/api/closings', (_request, response) => response.json({ items: listDailyClosings() }));
  app.get('/api/closings/preview', (request, response) => response.json({ item: previewDayClosing(request.query) }));
  app.post('/api/closings', (request, response, next) => { try { response.status(201).json({ item: closeDay(request.body) }); } catch (error) { next(error); } });
}
