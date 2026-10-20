/**
 * نمای عمومی لایهٔ داده.
 *
 * منطق در server/db/ است، هر بخش در فایل خودش. این فایل فقط همه را دوباره صادر
 * می‌کند تا هیچ واردکننده‌ای — سرور، اسکریپت‌ها و آزمون‌ها — عوض نشود.
 *
 * هیچ فایلی در server/db/ نباید این فایل را import کند: آزمون‌ها آن را با
 * query-string وارد می‌کنند و import مستقیم، نمونهٔ دوم پایگاه‌داده با زمینهٔ
 * کاری جداگانه می‌ساخت.
 */
export * from './db/core.js';
export * from './db/workspaces.js';
export * from './db/commercial.js';
export * from './db/settings.js';
export * from './db/accounts.js';
export * from './db/pettyCash.js';
export * from './db/transactions.js';
export * from './db/learnings.js';
export * from './db/aiLessons.js';
export * from './db/collaboration.js';
export * from './db/chart.js';
export * from './db/journal.js';
export * from './db/accountingTransfer.js';
export * from './db/firm.js';
export * from './db/contacts.js';
export * from './db/counterpartyCard.js';
export * from './db/accountCard.js';
export * from './db/obligations.js';
export * from './db/recurring.js';
export * from './db/invoices.js';
export * from './db/reconciliation.js';
export * from './db/closing.js';
export * from './db/receipts.js';
export * from './db/inventory.js';
export * from './db/tax.js';
export * from './db/payroll.js';
export * from './db/cheques.js';
export * from './db/insights.js';
export * from './db/voice.js';
export * from './db/backup.js';
export * from './db/auth.js';
export * from './db/approvalRequests.js';
export * from './db/fixedAssets.js';
export * from './db/financialEvents.js';
export * from './db/unidentified.js';
import { seedDemo } from './db/backup.js';

if (String(process.env.SEED_DEMO).toLowerCase() === 'true') seedDemo();

export * from './db/reviewIntakes.js';
export * from './db/understanding.js';
