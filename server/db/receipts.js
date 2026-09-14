import { randomUUID } from 'node:crypto';
import { audit, cleanAmount, currentWorkspace, db, invalidInput, parseStoredJson } from './core.js';
import { insertTransactionRows, jsonText } from './transactions.js';
import { matchStatementLine as matchStatementLineCore } from '../reconciliation.js';
import { normalizePersian } from '../../shared/parser.js';

function normalizeReceiptStatus(value, fallback = 'review') {
  return ['pending', 'review', 'ready', 'linked', 'failed', 'ignored'].includes(value) ? value : fallback;
}

export function receiptSelect(where = '') {
  return `SELECT receipts.id,receipts.file_name AS fileName,receipts.mime_type AS mimeType,receipts.note,receipts.amount,receipts.type,
    receipts.category,receipts.merchant,receipts.occurred_at AS occurredAt,receipts.payment_method AS paymentMethod,receipts.reference,
    receipts.account_id AS accountId,accounts.name AS accountName,receipts.transaction_id AS transactionId,
    receipts.statement_line_id AS statementLineId,receipts.status,receipts.ocr_provider AS ocrProvider,receipts.ocr_model AS ocrModel,
    receipts.ocr_confidence AS ocrConfidence,receipts.field_confidence AS fieldConfidence,receipts.ocr_text AS ocrText,
    receipts.review_reasons AS reviewReasons,receipts.created_at AS createdAt,COALESCE(receipts.updated_at,receipts.created_at) AS updatedAt
    FROM receipts LEFT JOIN accounts ON accounts.id=receipts.account_id ${where}`;
}

export function hydrateReceipt(row) {
  if (!row) return null;
  return { ...row, fieldConfidence: parseStoredJson(row.fieldConfidence, {}), reviewReasons: parseStoredJson(row.reviewReasons, []) };
}

function normalizedRuleText(value) {
  return normalizePersian(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function findAutomationRule(source, text, type = null) {
  const haystack = normalizedRuleText(text);
  if (!haystack) return null;
  return listAutomationRules(source).find((rule) => (!rule.type || !type || rule.type === type) && haystack.includes(normalizedRuleText(rule.pattern))) || null;
}

export function saveReceipt({
  buffer, fileName, mimeType, note = '', amount = null, type = null, category = null, merchant = '', occurredAt = null,
  paymentMethod = '', reference = '', accountId = null, status = 'review', ocrProvider = '', ocrModel = '', ocrConfidence = 0,
  fieldConfidence = {}, ocrText = '', reviewReasons = [],
}) {
  if (!buffer?.length) throw invalidInput('تصویر رسید خالی است.');
  const id = randomUUID();
  const normalizedAmount = amount ? cleanAmount(amount) : null;
  const normalizedType = ['income', 'expense'].includes(type) ? type : null;
  const rule = findAutomationRule('merchant', merchant, normalizedType);
  const resolvedCategory = String(category || rule?.category || '').trim().slice(0, 80) || null;
  const resolvedAccountId = accountId || rule?.accountId || null;
  if (resolvedAccountId && !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(resolvedAccountId)) throw invalidInput('حساب پیشنهادی رسید معتبر نیست.');
  db.prepare(`INSERT INTO receipts
    (id,file_name,mime_type,image_data,note,amount,type,category,merchant,occurred_at,payment_method,reference,account_id,status,
      ocr_provider,ocr_model,ocr_confidence,field_confidence,ocr_text,review_reasons,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(id, String(fileName || 'receipt').slice(0, 160), mimeType, buffer, String(note || '').slice(0, 800), normalizedAmount,
      normalizedType, resolvedCategory, String(merchant || '').trim().slice(0, 160), occurredAt || null,
      String(paymentMethod || '').trim().slice(0, 80), String(reference || '').trim().slice(0, 120), resolvedAccountId,
      normalizeReceiptStatus(status), String(ocrProvider || '').slice(0, 40), String(ocrModel || '').slice(0, 80),
      Math.max(0, Math.min(1, Number(ocrConfidence) || 0)), jsonText(fieldConfidence, {}), String(ocrText || '').slice(0, 4000), jsonText(reviewReasons, []));
  audit('create', 'receipt', id, { fileName, amount: normalizedAmount, provider: ocrProvider, status });
  return getReceipt(id);
}

export function getReceipt(id) {
  return hydrateReceipt(db.prepare(`${receiptSelect('WHERE receipts.id=?')}`).get(id));
}

export function listReceipts({ status = '' } = {}) {
  const validStatus = normalizeReceiptStatus(status, '');
  const rows = validStatus
    ? db.prepare(`${receiptSelect('WHERE receipts.status=?')} ORDER BY receipts.created_at DESC LIMIT 100`).all(validStatus)
    : db.prepare(`${receiptSelect()} ORDER BY CASE receipts.status WHEN 'failed' THEN 0 WHEN 'review' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END,receipts.created_at DESC LIMIT 100`).all();
  return rows.map(hydrateReceipt);
}

export function updateReceipt(id, values = {}) {
  const current = getReceipt(id);
  if (!current || current.status === 'linked') return null;
  const amount = values.amount == null || values.amount === '' ? current.amount : cleanAmount(values.amount);
  const type = ['income', 'expense'].includes(values.type) ? values.type : current.type;
  const category = String(values.category ?? current.category ?? '').trim().slice(0, 80) || null;
  const accountId = String(values.accountId ?? current.accountId ?? '').trim() || null;
  if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(accountId)) throw invalidInput('حساب انتخاب‌شده معتبر نیست.');
  const occurredAt = values.occurredAt ? new Date(values.occurredAt).toISOString() : current.occurredAt;
  const ready = Boolean(amount && type && category && accountId);
  const status = normalizeReceiptStatus(values.status, ready ? 'ready' : 'review');
  db.prepare(`UPDATE receipts SET amount=?,type=?,category=?,merchant=?,occurred_at=?,payment_method=?,reference=?,account_id=?,note=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(amount, type, category, String(values.merchant ?? current.merchant ?? '').trim().slice(0, 160), occurredAt,
      String(values.paymentMethod ?? current.paymentMethod ?? '').trim().slice(0, 80), String(values.reference ?? current.reference ?? '').trim().slice(0, 120),
      accountId, String(values.note ?? current.note ?? '').trim().slice(0, 800), status, id);
  audit('update', 'receipt', id, { amount, type, category, accountId, status });
  return getReceipt(id);
}

function dateDistance(left, right) {
  if (!left || !right) return null;
  return Math.abs(new Date(left).getTime() - new Date(right).getTime()) / 86_400_000;
}

export function receiptCandidates(id) {
  const receipt = getReceipt(id);
  if (!receipt || !receipt.amount || !receipt.type) return { transactions: [], statementLines: [] };
  const occurredAt = receipt.occurredAt || receipt.createdAt;
  const transactions = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,transactions.raw_text AS rawText,
    transactions.occurred_at AS occurredAt,transactions.account_id AS accountId,accounts.name AS accountName
    FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.status!='deleted' AND transactions.amount=? AND transactions.type=?
      AND ABS(julianday(transactions.occurred_at)-julianday(?))<=7
    ORDER BY ABS(julianday(transactions.occurred_at)-julianday(?)) LIMIT 5`).all(receipt.amount, receipt.type, occurredAt, occurredAt)
    .map((item) => {
      const distance = dateDistance(item.occurredAt, occurredAt);
      const merchantMatch = receipt.merchant && normalizedRuleText(item.rawText).includes(normalizedRuleText(receipt.merchant));
      const score = Math.min(100, Math.round(70 + Math.max(0, 20 - (distance || 0) * 5) + (merchantMatch ? 10 : 0)));
      return { ...item, score, reasons: ['مبلغ و نوع برابر است.', distance < 1 ? 'تاریخ یکسان است.' : `فاصلهٔ تاریخ ${Math.round(distance)} روز است.`, ...(merchantMatch ? ['نام فروشنده در شرح تراکنش دیده شد.'] : [])] };
    });
  const statementLines = db.prepare(`SELECT bank_statement_lines.id,bank_statement_lines.amount,bank_statement_lines.direction AS type,
    bank_statement_lines.description,bank_statement_lines.reference,bank_statement_lines.occurred_at AS occurredAt,
    bank_statement_imports.account_id AS accountId,accounts.name AS accountName
    FROM bank_statement_lines JOIN bank_statement_imports ON bank_statement_imports.id=bank_statement_lines.import_id
    JOIN accounts ON accounts.id=bank_statement_imports.account_id
    WHERE bank_statement_lines.status='unmatched' AND bank_statement_imports.status='open'
      AND bank_statement_lines.amount=? AND bank_statement_lines.direction=?
      AND ABS(julianday(bank_statement_lines.occurred_at)-julianday(?))<=7
    ORDER BY ABS(julianday(bank_statement_lines.occurred_at)-julianday(?)) LIMIT 5`).all(receipt.amount, receipt.type, occurredAt, occurredAt)
    .map((item) => {
      const distance = dateDistance(item.occurredAt, occurredAt);
      const merchantMatch = receipt.merchant && normalizedRuleText(`${item.description} ${item.reference}`).includes(normalizedRuleText(receipt.merchant));
      const score = Math.min(100, Math.round(70 + Math.max(0, 20 - (distance || 0) * 5) + (merchantMatch ? 10 : 0)));
      return { ...item, score, reasons: ['مبلغ و نوع برابر است.', distance < 1 ? 'تاریخ یکسان است.' : `فاصلهٔ تاریخ ${Math.round(distance)} روز است.`, ...(merchantMatch ? ['نام فروشنده در شرح بانک دیده شد.'] : [])] };
    });
  return { transactions, statementLines };
}

export function confirmReceipt(id, values = {}) {
  let receipt = updateReceipt(id, values);
  if (!receipt) return null;
  if (!receipt.amount || !receipt.type || !receipt.category || !receipt.accountId) throw Object.assign(new Error('مبلغ، نوع، دسته و حساب را پیش از ثبت کامل کن.'), { code: 'RECEIPT_INCOMPLETE', status: 409 });
  db.exec('BEGIN IMMEDIATE');
  try {
    let transactionId = String(values.transactionId || '').trim();
    const statementLineId = String(values.statementLineId || '').trim();
    if (transactionId) {
      const transaction = db.prepare("SELECT id,amount,type,account_id AS accountId FROM transactions WHERE id=? AND status!='deleted'").get(transactionId);
      if (!transaction || transaction.amount !== receipt.amount || transaction.type !== receipt.type || transaction.accountId !== receipt.accountId) throw Object.assign(new Error('تراکنش انتخاب‌شده با مبلغ، نوع و حساب رسید برابر نیست.'), { code: 'RECEIPT_MATCH_MISMATCH', status: 409 });
    } else {
      const [createdId] = insertTransactionRows({ transcript: receipt.ocrText || receipt.note || receipt.merchant || 'ثبت از رسید', transactions: [{
        clientId: `receipt:${receipt.id}`, amount: receipt.amount, type: receipt.type, category: receipt.category,
        rawText: receipt.ocrText || receipt.note || receipt.merchant || 'ثبت از رسید', source: 'text', accountId: receipt.accountId,
        occurredAt: receipt.occurredAt || receipt.createdAt, confidence: receipt.ocrConfidence || 1,
        note: `ثبت از رسید ${receipt.fileName}${receipt.reference ? ` · پیگیری ${receipt.reference}` : ''}`,
      }] });
      transactionId = createdId;
    }
    if (statementLineId) matchStatementLineCore(db, statementLineId, transactionId, { resolvedBy: currentWorkspace()?.userId, note: 'تطبیق با رسید تأییدشده' });
    db.prepare(`UPDATE receipts SET transaction_id=?,statement_line_id=?,status='linked',updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(transactionId, statementLineId || null, id);
    audit('confirm', 'receipt', id, { transactionId, statementLineId: statementLineId || null });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReceipt(id);
}

export function listAutomationRules(source = '') {
  const params = source ? [source] : [];
  return db.prepare(`SELECT automation_rules.id,automation_rules.source,automation_rules.pattern,automation_rules.type,
    automation_rules.category,automation_rules.account_id AS accountId,accounts.name AS accountName,
    automation_rules.created_at AS createdAt,automation_rules.updated_at AS updatedAt
    FROM automation_rules LEFT JOIN accounts ON accounts.id=automation_rules.account_id
    ${source ? 'WHERE automation_rules.source=?' : ''} ORDER BY length(automation_rules.pattern) DESC,automation_rules.updated_at DESC`).all(...params);
}

export function saveAutomationRule(values = {}) {
  const source = ['merchant', 'bank_description'].includes(values.source) ? values.source : null;
  const pattern = normalizedRuleText(values.pattern).slice(0, 120);
  const type = ['income', 'expense'].includes(values.type) ? values.type : null;
  const category = String(values.category || '').trim().slice(0, 80);
  const accountId = String(values.accountId || '').trim() || null;
  if (!source || pattern.length < 2 || !category) throw invalidInput('منبع، عبارت و دستهٔ قانون را کامل کن.');
  if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(accountId)) throw invalidInput('حساب قانون معتبر نیست.');
  const id = values.id || randomUUID();
  db.prepare(`INSERT INTO automation_rules (id,source,pattern,type,category,account_id,created_by) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source,pattern) DO UPDATE SET type=excluded.type,category=excluded.category,account_id=excluded.account_id,updated_at=CURRENT_TIMESTAMP`)
    .run(id, source, pattern, type, category, accountId, currentWorkspace()?.userId || null);
  audit(values.id ? 'update' : 'create', 'automation_rule', id, { source, pattern, type, category, accountId });
  return listAutomationRules(source).find((item) => item.pattern === pattern);
}

export function deleteAutomationRule(id) {
  const result = db.prepare('DELETE FROM automation_rules WHERE id=?').run(id);
  if (result.changes) audit('delete', 'automation_rule', id);
  return result.changes > 0;
}

export function receiptImage(id) {
  const row = db.prepare('SELECT mime_type AS mimeType,image_data AS imageData FROM receipts WHERE id=?').get(id);
  return row ? { ...row, imageData: Buffer.from(row.imageData) } : null;
}

export function deleteReceipt(id) {
  const result = db.prepare('DELETE FROM receipts WHERE id=?').run(id);
  if (result.changes) audit('delete', 'receipt', id);
  return result.changes > 0;
}
