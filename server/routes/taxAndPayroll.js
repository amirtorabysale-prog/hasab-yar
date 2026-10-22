// مالیات، دستیار مالیاتی و حقوق.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  listTaxRates, importPayrollFile, listPayrollRuns, payPayrollLiability, payPayrollSalaries, reversePayrollRun, settleVatPeriod, claimVatRefund, saveTaxRate, taxReport, askTaxAssistant, listTaxAssistantQuestions, listTaxKnowledgeSources, resolveTaxAssistantQuestion, saveTaxKnowledgeSource,
} from '../db.js';
import { chartUpload } from './http.js';

export function registerTaxAndPayrollRoutes(app) {
  app.post('/api/tax/settle-vat', (request, response, next) => {
    try { return response.json(settleVatPeriod(request.body || {})); } catch (error) { return next(error); }
  });
  app.post('/api/tax/vat-refund-claim', (request, response, next) => {
    try {
      const { amount, occurredAt, reference, memo } = request.body || {};
      return response.status(201).json({ item: claimVatRefund({ amount, occurredAt, reference, memo }) });
    } catch (error) { return next(error); }
  });
  // لیست حقوق: فایل دفتر، سند، و تسویهٔ سه بدهیِ جدا.
  app.get('/api/payroll', (request, response, next) => {
    try { return response.json({ items: listPayrollRuns({ limit: request.query?.limit }) }); } catch (error) { return next(error); }
  });
  app.post('/api/payroll/import', chartUpload.single('file'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
      return response.status(201).json(importPayrollFile(request.file.buffer, request.file.originalname, {
        period: request.body?.period, occurredAt: request.body?.occurredAt, note: request.body?.note,
      }));
    } catch (error) { return next(error); }
  });
  app.post('/api/payroll/:id/pay-salaries', (request, response, next) => {
    try { return response.json(payPayrollSalaries(request.params.id, request.body || {})); } catch (error) { return next(error); }
  });
  app.post('/api/payroll/:id/pay/:kind', (request, response, next) => {
    try { return response.json(payPayrollLiability(request.params.id, request.params.kind, request.body || {})); } catch (error) { return next(error); }
  });
  app.delete('/api/payroll/:id', (request, response, next) => {
    try { return response.json(reversePayrollRun(request.params.id)); } catch (error) { return next(error); }
  });
  app.get('/api/tax/rates', (_request, response) => response.json({ items: listTaxRates() }));
  app.post('/api/tax/rates', (request, response, next) => { try { response.status(201).json({ item: saveTaxRate(request.body) }); } catch (error) { next(error); } });
  app.put('/api/tax/rates/:id', (request, response, next) => { try { response.json({ item: saveTaxRate({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
  app.get('/api/tax/report', (request, response, next) => { try { response.json(taxReport(request.query)); } catch (error) { next(error); } });
  app.get('/api/tax-assistant/sources', (_request, response) => response.json({ items: listTaxKnowledgeSources() }));
  app.post('/api/tax-assistant/sources', (request, response, next) => {
    try { return response.status(201).json({ item: saveTaxKnowledgeSource(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.put('/api/tax-assistant/sources/:id', (request, response, next) => {
    try { return response.json({ item: saveTaxKnowledgeSource({ ...request.body, id: request.params.id }) }); } catch (error) { return next(error); }
  });
  // هستهٔ منابع نسخه‌دار (فاز ۰ و ۱). مسیر پاسخ دستیار هنوز از منابع قدیمی است.
  app.get('/api/tax-knowledge/documents', (request, response, next) => {
    try { return response.json({ items: listTaxDocuments({ documentClass: request.query.documentClass || '' }) }); }
    catch (error) { return next(error); }
  });
  app.get('/api/tax-knowledge/documents/:id', (request, response) => {
    const item = getTaxDocument(request.params.id);
    return item ? response.json({ item }) : response.status(404).json({ message: 'سند مالیاتی پیدا نشد.' });
  });
  app.post('/api/tax-knowledge/documents', (request, response, next) => {
    try { return response.status(201).json({ item: saveTaxDocumentDraft(request.body || {}) }); }
    catch (error) { return next(error); }
  });
  app.get('/api/tax-knowledge/review-queue', (_request, response, next) => {
    try { return response.json({ items: listTaxReviewQueue() }); } catch (error) { return next(error); }
  });
  app.get('/api/tax-knowledge/versions/:id', (request, response) => {
    const item = getTaxDocumentVersion(request.params.id);
    return item ? response.json({ item }) : response.status(404).json({ message: 'نسخهٔ سند پیدا نشد.' });
  });
  app.post('/api/tax-knowledge/versions/:id/publish', (request, response, next) => {
    try {
      const item = publishTaxDocumentVersion(request.params.id);
      return item ? response.json({ item }) : response.status(404).json({ message: 'نسخهٔ سند پیدا نشد.' });
    } catch (error) { return next(error); }
  });
  app.post('/api/tax-knowledge/versions/:id/reject', (request, response, next) => {
    try {
      const item = rejectTaxDocumentVersion(request.params.id, request.body?.reason || '');
      return item ? response.json({ item }) : response.status(404).json({ message: 'نسخهٔ سند پیدا نشد.' });
    } catch (error) { return next(error); }
  });
  app.post('/api/tax-knowledge/relations', (request, response, next) => {
    try { return response.status(201).json({ item: saveTaxDocumentRelation(request.body || {}) }); }
    catch (error) { return next(error); }
  });
  app.get('/api/tax-knowledge/citable', (request, response, next) => {
    try {
      return response.json({ items: citableTaxVersions({ asOf: request.query.asOf, fiscalYear: request.query.fiscalYear }) });
    } catch (error) { return next(error); }
  });
  app.get('/api/tax-assistant/questions', (request, response) => response.json({ items: listTaxAssistantQuestions(request.query) }));
  app.post('/api/tax-assistant/questions', (request, response, next) => {
    try { return response.status(201).json({ item: askTaxAssistant(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/tax-assistant/questions/:id/resolve', (request, response, next) => {
    try {
      const item = resolveTaxAssistantQuestion(request.params.id, request.body || {});
      return item ? response.json({ item }) : response.status(404).json({ code: 'TAX_QUESTION_NOT_FOUND', message: 'سؤال پیدا نشد.' });
    } catch (error) { return next(error); }
  });
}
