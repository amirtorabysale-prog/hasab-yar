// اشخاص، طلب و بدهی، تکرارشونده، فاکتور، رسید و کالا.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  adjustStock, beginProviderUsage, createInvoice, deleteContact, deleteInvoice, deleteObligation, deleteReceipt, deleteRecurringRule, finishProviderUsage, getCategories, getInvoice, getLearnings, getReceipt, inventoryOverview, counterpartyCard, issueInvoice, listContacts, listInvoices, listObligations, listProducts, listReceipts, listRecurringRules, markInvoicePaid, receiptCandidates, receiptImage, recordInvoicePayment, saveContact, saveObligation, saveRecurringRule, settleObligation, settlePayableBalanceByPartner, settleLedgerBalance, confirmReceipt, saveProduct, saveReceipt, typicalAmounts, updateReceipt,
} from '../db.js';
import { parseFinancialText } from '../parser.js';
import { extractReceiptData, receiptOcrConfigured } from '../receiptOcr.js';
import { SUPPORTED_RECEIPT_TYPES, acceptReceiptImage } from '../imageIntake.js';
import { upload } from './http.js';

export function registerLedgerRoutes(app) {
  app.get('/api/contacts', (_request, response) => response.json({ items: listContacts() }));
  // کارت حساب یک طرف حساب: گردشش از دفتر کل، با مانده‌گیری تجمعی. بازه اختیاری
  // است و وقتی داده شود، مانده پیش از آن به‌عنوان افتتاحیه برمی‌گردد.
  app.get('/api/contacts/:id/card', (request, response, next) => {
    try {
      return response.json(counterpartyCard(request.params.id, {
        from: String(request.query.from || '').slice(0, 40),
        to: String(request.query.to || '').slice(0, 40),
      }));
    } catch (error) { return next(error); }
  });
  app.post('/api/contacts', (request, response, next) => { try { response.status(201).json({ item: saveContact(request.body) }); } catch (error) { next(error); } });
  app.put('/api/contacts/:id', (request, response, next) => { try { response.json({ item: saveContact({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
  app.delete('/api/contacts/:id', (request, response) => response.status(deleteContact(request.params.id) ? 204 : 404).end());
  app.get('/api/obligations', (request, response) => response.json({ items: listObligations({ status: request.query.status || 'open' }) }));
  app.post('/api/obligations', (request, response, next) => { try { response.status(201).json({ item: saveObligation(request.body) }); } catch (error) { next(error); } });
  app.put('/api/obligations/:id', (request, response, next) => { try { response.json({ item: saveObligation({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
  app.post('/api/contacts/:id/settle-balance', (request, response, next) => { try { return response.json(settleLedgerBalance(request.params.id, request.body || {})); } catch (error) { return next(error); } });
  app.post('/api/contacts/:id/partner-settle', (request, response, next) => { try { return response.json(settlePayableBalanceByPartner(request.params.id, request.body || {})); } catch (error) { return next(error); } });
  app.post('/api/obligations/:id/settle', (request, response, next) => { try { const result = settleObligation(request.params.id, request.body); return result ? response.json(result) : response.status(404).json({ message: 'طلب یا بدهی باز پیدا نشد.' }); } catch (error) { return next(error); } });
  app.delete('/api/obligations/:id', (request, response) => response.status(deleteObligation(request.params.id) ? 204 : 404).end());
  app.get('/api/recurring', (_request, response) => response.json({ items: listRecurringRules() }));
  app.post('/api/recurring', (request, response, next) => { try { response.status(201).json({ item: saveRecurringRule(request.body) }); } catch (error) { next(error); } });
  app.delete('/api/recurring/:id', (request, response) => response.status(deleteRecurringRule(request.params.id) ? 204 : 404).end());
  app.get('/api/invoices', (request, response) => response.json(listInvoices({ status: request.query.status, documentType: request.query.documentType })));
  app.get('/api/invoices/:id', (request, response) => { const item = getInvoice(request.params.id); return item ? response.json({ item }) : response.status(404).json({ message: 'فاکتور پیدا نشد.' }); });
  app.post('/api/invoices', (request, response, next) => { try { response.status(201).json({ item: createInvoice(request.body) }); } catch (error) { next(error); } });
  app.post('/api/invoices/:id/issue', (request, response, next) => { try { const item = issueInvoice(request.params.id, request.body || {}); return item ? response.json({ item }) : response.status(404).json({ message: 'سند پیدا نشد.' }); } catch (error) { return next(error); } });
  app.post('/api/invoices/:id/payments', (request, response, next) => { try { const item = recordInvoicePayment(request.params.id, request.body || {}); return item ? response.status(201).json({ item }) : response.status(404).json({ message: 'سند باز پیدا نشد.' }); } catch (error) { return next(error); } });
  app.post('/api/invoices/:id/paid', (request, response, next) => { try { const item = markInvoicePaid(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'فاکتور پیدا نشد.' }); } catch (error) { return next(error); } });
  app.delete('/api/invoices/:id', (request, response) => response.status(deleteInvoice(request.params.id) ? 204 : 409).end());
  app.get('/api/receipts', (request, response) => response.json({ items: listReceipts({ status: request.query.status }), ocrConfigured: receiptOcrConfigured() }));
  app.get('/api/receipts/:id', (request, response) => {
    const item = getReceipt(request.params.id);
    return item ? response.json({ item, candidates: receiptCandidates(item.id) }) : response.status(404).json({ message: 'رسید پیدا نشد.' });
  });
  app.get('/api/receipts/:id/image', (request, response) => {
    const image = receiptImage(request.params.id);
    if (!image) return response.status(404).end();
    // نوع خروجی از فهرست بسته انتخاب می‌شود، نه از مقدار ذخیره‌شده؛ رسیدهای قدیمیِ
    // پیش از اعتبارسنجی باینری هم نباید بتوانند نوع دلخواه را به مرورگر تحمیل کنند.
    const safeType = SUPPORTED_RECEIPT_TYPES.includes(image.mimeType) ? image.mimeType : 'application/octet-stream';
    response.setHeader('Content-Type', safeType);
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Cache-Control', 'private, no-store');
    return response.send(image.imageData);
  });
  app.post('/api/receipts', upload.single('image'), async (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ message: 'یک تصویر JPG، PNG یا WebP انتخاب کن.' });
      // نوع فایل از بایت‌های خودش خوانده می‌شود و EXIF پیش از ذخیره حذف می‌شود؛
      // برچسب کلاینت و مختصات GPS عکس موبایل هیچ‌کدام وارد پایگاه‌دادهٔ مالی نمی‌شوند.
      const image = acceptReceiptImage(request.file.buffer, request.file.mimetype);
      const note = String(request.body.note || '');
      const parsed = parseFinancialText(note, { learnings: getLearnings(), averages: typicalAmounts(), source: 'text' });
      const noteSuggestion = parsed.transactions[0] || null;
      let extraction = null;
      let warning = null;
      let usageId = null;
      try {
        if (receiptOcrConfigured()) usageId = beginProviderUsage('receipt_ocr', 'openai');
        extraction = await extractReceiptData({ buffer: image.buffer, mimeType: image.mimeType, note, categories: getCategories() });
        if (usageId) finishProviderUsage(usageId, { provider: extraction.provider || 'openai' });
      } catch (error) {
        if (usageId) finishProviderUsage(usageId, { provider: error.provider || 'openai', succeeded: false, errorCode: error.code });
        warning = { code: error.code || 'RECEIPT_OCR_FAILED', message: error.message };
      }
      const reviewReasons = [...(extraction?.reviewReasons || [])];
      if (extraction?.amount && noteSuggestion?.amount && extraction.amount !== noteSuggestion.amount) reviewReasons.push('مبلغ تصویر و توضیح کاربر یکسان نیست؛ مبلغ تصویر پیشنهاد شده و باید کنترل شود.');
      if (!extraction && noteSuggestion) reviewReasons.push('مبلغ فقط از توضیح کاربر استخراج شده و با تصویر کنترل نشده است.');
      const amount = extraction?.amount || noteSuggestion?.amount || null;
      const type = noteSuggestion?.type || extraction?.type || null;
      const category = noteSuggestion?.category || extraction?.category || null;
      const accountId = String(request.body.accountId || noteSuggestion?.accountId || 'cash');
      const status = extraction?.status === 'ready' && amount && type && category ? 'ready' : extraction ? 'review' : warning ? 'failed' : 'review';
      const item = saveReceipt({
        buffer: image.buffer, fileName: request.file.originalname, mimeType: image.mimeType, note, amount, type, category, accountId,
        merchant: extraction?.merchant, occurredAt: extraction?.occurredAt, paymentMethod: extraction?.paymentMethod,
        reference: extraction?.reference, status, ocrProvider: extraction?.provider || (noteSuggestion ? 'note-parser' : ''),
        ocrModel: extraction?.model || '', ocrConfidence: extraction?.confidence || 0, fieldConfidence: extraction?.fieldConfidence || {},
        ocrText: extraction?.rawText || '', reviewReasons,
      });
      return response.status(201).json({ item, suggestion: extraction || noteSuggestion, warning, candidates: receiptCandidates(item.id) });
    } catch (error) { return next(error); }
  });
  app.put('/api/receipts/:id', (request, response, next) => { try { const item = updateReceipt(request.params.id, request.body || {}); return item ? response.json({ item, candidates: receiptCandidates(item.id) }) : response.status(404).json({ message: 'رسید باز پیدا نشد.' }); } catch (error) { return next(error); } });
  app.post('/api/receipts/:id/confirm', (request, response, next) => { try { const item = confirmReceipt(request.params.id, request.body || {}); return item ? response.json({ item }) : response.status(404).json({ message: 'رسید باز پیدا نشد.' }); } catch (error) { return next(error); } });
  app.delete('/api/receipts/:id', (request, response) => response.status(deleteReceipt(request.params.id) ? 204 : 404).end());
  app.get('/api/products', (_request, response) => response.json({ items: listProducts() }));
  app.get('/api/inventory/overview', (_request, response) => response.json(inventoryOverview()));
  app.post('/api/products', (request, response, next) => { try { response.status(201).json({ item: saveProduct(request.body) }); } catch (error) { next(error); } });
  app.put('/api/products/:id', (request, response, next) => { try { response.json({ item: saveProduct({ ...request.body, id: request.params.id }) }); } catch (error) { next(error); } });
  app.post('/api/products/:id/stock', (request, response, next) => { try { const item = adjustStock(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'کالا پیدا نشد.' }); } catch (error) { return next(error); } });
}
