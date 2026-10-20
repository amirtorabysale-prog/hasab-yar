import { ensureTaxRefundSchema } from '../reviewTaxRefund.js';
import { ensureInsuranceSettlementSchema } from '../reviewInsurance.js';
import { ensureUnidentifiedSchema } from '../unidentifiedReceipts.js';
import { ensureChequeSchema } from './cheques.js';
import { randomUUID } from 'node:crypto';
import { OPTIONAL_BACKUP_TABLES, PRESERVED_WHEN_ABSENT_TABLES } from '../backup.js';
import { ensureAccountingSchema } from '../accounting.js';
import { ensurePayrollSchema } from '../payroll.js';
import { ensureDepreciationSchema } from '../depreciationLedger.js';
import { currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { ensureTaxSchema } from '../tax.js';
import { insertTransactions } from './transactions.js';
import { migrateAccountingLedger } from '../accounting.js';
import { migrateInventory } from '../inventory.js';
import { ensureReviewAiSchema } from '../accountingReviewAi.js';
import { ensureUnderstandingSchema } from './understanding.js';
import { ensureAiLessonSchema } from './aiLessons.js';

export const FINANCIAL_BACKUP_TABLES = [
  'categories', 'accounts', 'petty_cash_funds', 'contacts', 'transactions', 'bank_statement_imports', 'bank_statement_lines', 'obligations', 'recurring_rules', 'invoices',
  'invoice_items', 'invoice_payments', 'daily_closings', 'receipts', 'products', 'stock_movements', 'learnings',
  'automation_rules', 'settings', 'voice_metrics', 'provider_usage', 'collaboration_requests', 'pilot_checkins', 'tax_rates',
  'tax_knowledge_sources', 'tax_assistant_questions',
  'tax_documents', 'tax_document_versions', 'tax_provisions', 'tax_document_relations', 'tax_document_mirrors',
  // کدینگ، تفصیلی و مرکز هزینه پیش از حساب‌ها و سطرهای سند که به آن‌ها ارجاع می‌دهند.
  'chart_accounts', 'analytic_accounts', 'cost_centers',
  'ledger_accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'financial_alert_feedback',
  'payroll_runs', 'payroll_lines', 'fixed_asset_settings', 'journal_templates',
  'accountant_intakes', 'financial_events', 'accounting_decisions', 'recognition_schedule_items', 'financial_event_audit', 'accounting_review_ai', 'accounting_review_tax_refunds', 'accounting_review_insurance', 'unidentified_receipt_resolutions', 'accounting_review_messages', 'accounting_review_context', 'cheques',
  'accounting_transfer_settings', 'accounting_transfer_mappings', 'accounting_transfer_batches', 'accounting_transfer_validations', 'audit_log',
  // پروندهٔ فهم رویداد: متن اصلی، نسخه‌ها و پاسخ‌ها — ردِ اینکه هر سند از کدام گفته آمد.
  'understanding_cases', 'understanding_versions',
  // درس‌هایی که پارسر از ثبت‌های AI گرفته: در حال یادگیری، یادگرفته، اختلاف‌های ساختاری.
  'ai_lessons',
];

const BACKUP_DELETE_ORDER = [
  'ai_lessons', 'understanding_versions', 'understanding_cases',
  'accounting_review_tax_refunds', 'accounting_review_insurance', 'unidentified_receipt_resolutions', 'accounting_review_messages', 'accounting_review_context', 'cheques', 'accountant_intakes', 'accounting_review_ai', 'financial_event_audit', 'recognition_schedule_items', 'accounting_decisions', 'financial_events',
  'accounting_transfer_validations', 'accounting_transfer_batches', 'accounting_transfer_mappings', 'accounting_transfer_settings',
  'payroll_lines', 'payroll_runs', 'fixed_asset_settings', 'journal_templates',
  'provider_usage', 'collaboration_requests', 'pilot_checkins', 'financial_alert_feedback', 'journal_lines', 'journal_entries', 'accounting_periods', 'ledger_accounts',
  'cost_centers', 'analytic_accounts', 'chart_accounts', 'bank_statement_lines', 'bank_statement_imports', 'invoice_payments',
  'stock_movements', 'invoice_items', 'obligations', 'transactions', 'receipts', 'daily_closings',
  'tax_document_mirrors', 'tax_document_relations', 'tax_provisions', 'tax_document_versions', 'tax_documents',
  'tax_assistant_questions', 'tax_knowledge_sources', 'automation_rules', 'recurring_rules', 'invoices', 'products', 'contacts', 'learnings', 'voice_metrics', 'tax_rates',
  'petty_cash_funds', 'accounts', 'categories', 'settings',
];

function ensureStructureSchemas(database) {
  ensureAccountingSchema(database);
  ensurePayrollSchema(database);
  ensureDepreciationSchema(database);
}

export function financialBackupSnapshot(workspace = currentWorkspace()) {
  // جدول پیشنهادهای AI و بازخورد حسابدار جزئی از سابقهٔ همان دفتر است.
  ensureReviewAiSchema(db);
  ensureTaxRefundSchema(db);
  ensureInsuranceSettlementSchema(db);
  ensureUnidentifiedSchema(db);
  ensureChequeSchema(db);
  ensureUnderstandingSchema(db);
  ensureAiLessonSchema(db);
  ensureStructureSchemas(db);
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
  ensureTaxRefundSchema(db);
  ensureInsuranceSettlementSchema(db);
  ensureUnidentifiedSchema(db);
  ensureChequeSchema(db);
  ensureUnderstandingSchema(db);
  ensureAiLessonSchema(db);
  ensureStructureSchemas(db);
  db.exec('PRAGMA defer_foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    // پشتیبان قدیمی که ساختار دفتر را ندارد، همان ساختار فعلی را نگه می‌دارد.
    const kept = (table) => PRESERVED_WHEN_ABSENT_TABLES.has(table) && snapshot.tables[table] === undefined;
    for (const table of BACKUP_DELETE_ORDER) if (!kept(table)) db.prepare(`DELETE FROM ${table}`).run();
    for (const table of FINANCIAL_BACKUP_TABLES) {
      if (kept(table)) continue;
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
