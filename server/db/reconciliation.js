import { audit, currentWorkspace, db } from './core.js';
import { closeReconciliation as closeReconciliationCore, getReconciliationImport as getReconciliationImportCore, getStatementLine, ignoreStatementLine as ignoreStatementLineCore, importBankStatement as importBankStatementCore, listReconciliationImports as listReconciliationImportsCore, matchStatementLine as matchStatementLineCore } from '../reconciliation.js';
import { findAutomationRule } from './receipts.js';
import { insertTransactionRows } from './transactions.js';
import { bookedServiceFacts } from '../../shared/documentReading.js';

export function importBankStatement(values = {}) {
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = importBankStatementCore(db, values, { createdBy: currentWorkspace()?.userId });
    importId = item.id;
    audit('import', 'bank_statement', item.id, { fileName: values.fileName, accountId: values.accountId, rows: item.rowCount });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function listReconciliationImports() {
  return listReconciliationImportsCore(db);
}

export function getReconciliationImport(id) {
  const item = getReconciliationImportCore(db, id);
  if (!item) return null;
  item.lines = item.lines.map((line) => {
    const rule = findAutomationRule('bank_description', `${line.description} ${line.reference}`, line.direction);
    return { ...line, ruleSuggestion: rule ? { id: rule.id, pattern: rule.pattern, category: rule.category, accountId: rule.accountId } : null };
  });
  return item;
}

export function matchReconciliationLine(lineId, transactionId) {
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = matchStatementLineCore(db, lineId, transactionId, { resolvedBy: currentWorkspace()?.userId });
    importId = item.id;
    audit('match', 'bank_statement_line', lineId, { transactionId });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function createTransactionFromStatementLine(lineId, values = {}) {
  const line = getStatementLine(db, lineId);
  if (!line || line.status !== 'unmatched' || line.import_status !== 'open') return null;
  const rule = findAutomationRule('bank_description', `${line.description} ${line.reference}`, line.direction);
  const category = String(values.category || rule?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')).trim().slice(0, 80);
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    // شرح بانک دورهٔ پوشش را گفته باشد («حق بیمه … یکساله»)، همان دوره به موتور
    // می‌رسد؛ وگرنه ردیفی که بانک تاریخش را داده باز «دوره از کی؟» می‌پرسید.
    const service = bookedServiceFacts(line.description, { type: line.direction, category, occurredAt: line.occurred_at });
    const [transactionId] = insertTransactionRows({ transcript: line.description || 'ثبت از صورت‌حساب بانکی', transactions: [{
      clientId: `statement-line:${line.id}`, amount: line.amount, type: line.direction, category,
      rawText: line.description || `ردیف بانکی ${line.reference}`, note: `ثبت از تطبیق بانکی${line.reference ? ` · پیگیری ${line.reference}` : ''}`,
      source: 'text', accountId: line.account_id, occurredAt: line.occurred_at, ...service,
    }] });
    const item = matchStatementLineCore(db, lineId, transactionId, { resolvedBy: currentWorkspace()?.userId, note: 'ساخت تراکنش از ردیف بانک' });
    importId = item.id;
    audit('create-transaction', 'bank_statement_line', lineId, { transactionId, category });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function ignoreReconciliationLine(lineId, reason) {
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = ignoreStatementLineCore(db, lineId, reason, { resolvedBy: currentWorkspace()?.userId });
    importId = item.id;
    audit('ignore', 'bank_statement_line', lineId, { reason });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function closeBankReconciliation(importId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = closeReconciliationCore(db, importId, currentWorkspace()?.userId);
    audit('close', 'bank_reconciliation', importId, { difference: item.difference });
    db.exec('COMMIT');
    return item;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
