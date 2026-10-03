import { ensureChequeSchema } from './cheques.js';
import { randomUUID } from 'node:crypto';
import { OPTIONAL_BACKUP_TABLES } from '../backup.js';
import { currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { ensureTaxSchema } from '../tax.js';
import { insertTransactions } from './transactions.js';
import { migrateAccountingLedger } from '../accounting.js';
import { migrateInventory } from '../inventory.js';
import { ensureReviewAiSchema } from '../accountingReviewAi.js';

export const FINANCIAL_BACKUP_TABLES = [
  'categories', 'accounts', 'contacts', 'transactions', 'bank_statement_imports', 'bank_statement_lines', 'obligations', 'recurring_rules', 'invoices',
  'invoice_items', 'invoice_payments', 'daily_closings', 'receipts', 'products', 'stock_movements', 'learnings',
  'automation_rules', 'settings', 'voice_metrics', 'provider_usage', 'collaboration_requests', 'pilot_checkins', 'tax_rates',
  'tax_knowledge_sources', 'tax_assistant_questions',
  'tax_documents', 'tax_document_versions', 'tax_provisions', 'tax_document_relations', 'tax_document_mirrors',
  'ledger_accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'financial_alert_feedback',
  'accountant_intakes', 'financial_events', 'accounting_decisions', 'recognition_schedule_items', 'financial_event_audit', 'accounting_review_ai', 'accounting_review_messages', 'accounting_review_context', 'cheques',
  'accounting_transfer_settings', 'accounting_transfer_mappings', 'accounting_transfer_batches', 'accounting_transfer_validations', 'audit_log',
];

const BACKUP_DELETE_ORDER = [
  'accounting_review_messages', 'accounting_review_context', 'cheques', 'accountant_intakes', 'accounting_review_ai', 'financial_event_audit', 'recognition_schedule_items', 'accounting_decisions', 'financial_events',
  'accounting_transfer_validations', 'accounting_transfer_batches', 'accounting_transfer_mappings', 'accounting_transfer_settings',
  'provider_usage', 'collaboration_requests', 'pilot_checkins', 'financial_alert_feedback', 'journal_lines', 'journal_entries', 'accounting_periods', 'ledger_accounts', 'bank_statement_lines', 'bank_statement_imports', 'invoice_payments',
  'stock_movements', 'invoice_items', 'obligations', 'transactions', 'receipts', 'daily_closings',
  'tax_document_mirrors', 'tax_document_relations', 'tax_provisions', 'tax_document_versions', 'tax_documents',
  'tax_assistant_questions', 'tax_knowledge_sources', 'automation_rules', 'recurring_rules', 'invoices', 'products', 'contacts', 'learnings', 'voice_metrics', 'tax_rates',
  'accounts', 'categories', 'settings',
];

export function financialBackupSnapshot(workspace = currentWorkspace()) {
  // جدول پیشنهادهای AI و بازخورد حسابدار جزئی از سابقهٔ همان دفتر است.
  ensureReviewAiSchema(db);
  ensureChequeSchema(db);
  const tables = {};
  for (const table of FINANCIAL_BACKUP_TABLES) tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  return {
    format: 'hesab-yar-financial-data', version: 1, exportedAt: new Date().toISOString(),
    workspace: { id: workspace?.id || 'primary' }, tables,
  };
}

export function restoreFinancialSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== 'hesab-yar-financial-data' || snapshot.version !== 1 || !snapshot.tables) throw invalidInput('ساختار پشتیبان معتبر نیست.');
  ensureReviewAiSchema(db);
  ensureChequeSchema(db);
  db.exec('PRAGMA defer_foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of BACKUP_DELETE_ORDER) db.prepare(`DELETE FROM ${table}`).run();
    for (const table of FINANCIAL_BACKUP_TABLES) {
      // جدولی که بعد از ساخت آن پشتیبان به محصول اضافه شده، خالی بازیابی می‌شود؛
      // پشتیبان قدیمی نباید به‌خاطر قابلیتی که آن روز وجود نداشته رد شود.
      const rows = snapshot.tables[table] ?? (OPTIONAL_BACKUP_TABLES.has(table) ? [] : undefined);
      if (!Array.isArray(rows)) throw invalidInput(`جدول ${table} در پشتیبان کامل نیست.`);
      const validColumns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
      for (const row of rows) {
        const columns = Object.keys(row).filter((column) => validColumns.has(column));
        if (!columns.length) continue;
        const placeholders = columns.map(() => '?').join(',');
        const command = table === 'audit_log' ? 'INSERT OR IGNORE' : 'INSERT';
        db.prepare(`${command} INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`).run(...columns.map((column) => row[column]));
      }
    }
    ensureTaxSchema(db);
    const cash = db.prepare("SELECT id FROM accounts WHERE id='cash'").get();
    if (!cash) throw invalidInput('پشتیبان حساب صندوق اصلی را ندارد.');
    migrateAccountingLedger(db, { createdBy: currentWorkspace()?.userId });
    migrateInventory(db, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    db.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
      .run(randomUUID(), 'restore', 'workspace', currentWorkspace()?.id || 'primary', JSON.stringify({ restoredAt: new Date().toISOString() }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return financialBackupSnapshot();
}

export function seedDemo() {
  if (db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count) return 0;
  const now = new Date();
  const samples = [
    { amount: 12_000_000, type: 'income', category: 'فروش', rawText: 'امروز دوازده میلیون فروش داشتم', occurredAt: new Date(now.getTime() - 30 * 60_000).toISOString() },
    { amount: 2_500_000, type: 'expense', category: 'حقوق و دستمزد', rawText: 'دو میلیون و پانصد هزار حقوق دادم', occurredAt: new Date(now.getTime() - 90 * 60_000).toISOString() },
    { amount: 1_200_000, type: 'expense', category: 'مواد و کالا', rawText: 'یک میلیون و دویست مواد خریدم', occurredAt: new Date(now.getTime() - 160 * 60_000).toISOString() },
  ];
  insertTransactions({ transcript: 'داده نمونه', transactions: samples });
  return samples.length;
}
