// تحویل به حسابدار: بستهٔ انتقال پارسیان و اکسل، همکاری.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  accountingTransferBatchFile, accountingTransferOverview, answerCollaborationRequest, claimAccountingTransferBatchDownload, commercialStatus, createAccountingTransferBatch, createAccountingTransferValidation, createCollaborationRequest, listCollaborationRequests, monthlyAccountantPackage, pilotWorkspaceDashboard, transferFieldCatalog, saveAccountingTransferTemplate, fillTransferMappingsFromChart, listAccountingTransferBatches, listAccountingTransferValidations, resolveCollaborationRequest, saveAccountingTransferMapping, saveAccountingTransferSettings, updateAccountingTransferBatchStatus,
} from '../db.js';
import { transferTemplateUpload } from './http.js';

export function registerTransferRoutes(app) {
  app.get('/api/accountant-transfer/fields', (_request, response) => response.json(transferFieldCatalog()));
  app.get('/api/collaboration/overview', (request, response) => {
    const packageData = monthlyAccountantPackage(request.query.month);
    return response.json({
      package: {
        generatedAt: packageData.generatedAt, scope: packageData.scope, summary: packageData.summary,
        checklist: packageData.checklist, manifest: packageData.manifest, disclaimer: packageData.disclaimer,
      },
      requests: listCollaborationRequests({ status: request.query.status }),
      commercial: commercialStatus(request.workspace.id),
      pilot: pilotWorkspaceDashboard(),
    });
  });
  app.get('/api/collaboration/monthly-package', (request, response) => response.json(monthlyAccountantPackage(request.query.month)));
  app.get('/api/collaboration/monthly-package/download', (request, response) => {
    const packageData = monthlyAccountantPackage(request.query.month);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="hesab-yar-accountant-${request.workspace.id}-${packageData.scope.month}.json"`);
    return response.send(JSON.stringify(packageData, null, 2));
  });
  app.get('/api/accountant-transfer/overview', (request, response, next) => {
    try { return response.json(accountingTransferOverview(request.query.month, request.query.target)); }
    catch (error) { return next(error); }
  });
  app.put('/api/accountant-transfer/settings', (request, response, next) => {
    try { return response.json({ item: saveAccountingTransferSettings(request.body || {}) }); }
    catch (error) { return next(error); }
  });
  app.post('/api/accountant-transfer/template', transferTemplateUpload.single('file'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'IMPORT_FILE_MISSING', message: 'فایلی فرستاده نشد.' });
      return response.status(201).json({
        item: saveAccountingTransferTemplate(request.body?.targetSystem, request.file.buffer, request.file.originalname),
      });
    } catch (error) { return next(error); }
  });
  app.post('/api/accountant-transfer/mappings/from-chart', (request, response, next) => {
    try {
      return response.json(fillTransferMappingsFromChart(request.body?.targetSystem, { overwrite: request.body?.overwrite === true }));
    } catch (error) { return next(error); }
  });
  app.put('/api/accountant-transfer/mappings/:ledgerAccountId', (request, response, next) => {
    try {
      const item = saveAccountingTransferMapping({ ...request.body, ledgerAccountId: request.params.ledgerAccountId });
      return response.json({ item });
    } catch (error) { return next(error); }
  });
  app.get('/api/accountant-transfer/batches', (request, response) => response.json({ items: listAccountingTransferBatches(request.query) }));
  app.post('/api/accountant-transfer/batches', (request, response, next) => {
    try { return response.status(201).json({ item: createAccountingTransferBatch(request.body || {}) }); }
    catch (error) { return next(error); }
  });
  app.get('/api/accountant-transfer/batches/:id/download', (request, response) => {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({
      code: 'TRANSFER_DOWNLOAD_POST_REQUIRED',
      message: 'برای ثبت امن سابقهٔ تحویل، دریافت فایل باید از دکمهٔ داخل حساب‌یار انجام شود.',
    });
  });
  app.post('/api/accountant-transfer/batches/:id/download', (request, response, next) => {
    try {
      const item = claimAccountingTransferBatchDownload(request.params.id, request.body || {});
      if (!item) return response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
      response.setHeader('Content-Type', item.mimeType || 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', `attachment; filename="${item.fileName}"`);
      response.setHeader('X-Content-SHA256', item.digest);
      response.setHeader('X-HasabYar-Batch-ID', item.id);
      response.setHeader('X-HasabYar-Download-Count', String(item.downloadCount));
      return response.send(item.fileData);
    } catch (error) { return next(error); }
  });
  app.post('/api/accountant-transfer/batches/:id/status', (request, response, next) => {
    try {
      const item = updateAccountingTransferBatchStatus(request.params.id, request.body || {});
      return item ? response.json({ item }) : response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
    } catch (error) { return next(error); }
  });
  app.get('/api/accountant-transfer/batches/:id/validations', (request, response) => {
    const batch = accountingTransferBatchFile(request.params.id);
    if (!batch) return response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
    return response.json({ items: listAccountingTransferValidations(request.params.id) });
  });
  app.post('/api/accountant-transfer/batches/:id/validations', (request, response, next) => {
    try {
      const item = createAccountingTransferValidation(request.params.id, request.body || {});
      return item ? response.status(201).json({ item }) : response.status(404).json({ code: 'TRANSFER_BATCH_NOT_FOUND', message: 'بستهٔ خروجی پیدا نشد.' });
    } catch (error) { return next(error); }
  });
  app.post('/api/collaboration/requests', (request, response, next) => {
    try { return response.status(201).json({ item: createCollaborationRequest(request.body || {}) }); }
    catch (error) { return next(error); }
  });
  app.post('/api/collaboration/requests/:id/answer', (request, response, next) => {
    try {
      const item = answerCollaborationRequest(request.params.id, request.body?.answer);
      return item ? response.json({ item }) : response.status(404).json({ message: 'درخواست باز پیدا نشد.' });
    } catch (error) { return next(error); }
  });
  app.post('/api/collaboration/requests/:id/resolve', (request, response, next) => {
    try {
      const item = resolveCollaborationRequest(request.params.id);
      return item ? response.json({ item }) : response.status(409).json({ message: 'درخواست باید ابتدا پاسخ داده شود.' });
    } catch (error) { return next(error); }
  });
}
