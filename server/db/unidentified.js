import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace } from './core.js';
import { getInvoice } from './invoices.js';
import {
  RESOLUTION_TARGETS, listUnidentifiedHoldings, resolveUnidentifiedHolding, reverseUnidentifiedResolution,
} from '../unidentifiedReceipts.js';

/** وجوه ناشناسِ باز با تعیین تکلیف‌های فعالشان — برای صف حسابدار. */
export function listUnidentifiedReceipts({ includeClosed = false } = {}) {
  return { items: listUnidentifiedHoldings(activeWorkspaceDatabase(), { includeClosed }), targets: RESOLUTION_TARGETS };
}

export function resolveUnidentifiedReceipt(lineId, values = {}) {
  const database = activeWorkspaceDatabase();
  const helpers = {
    contact: (id) => database.prepare('SELECT id,name FROM contacts WHERE id=?').get(String(id)),
    invoice: (id) => getInvoice(String(id)),
  };
  database.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = resolveUnidentifiedHolding(database, lineId, values, { actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(), helpers });
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  audit('resolve', 'unidentified_receipt', result.id, { holdLineId: result.holdLineId, target: result.target, amount: result.amount, reason: String(values.reason || '').slice(0, 200) });
  return result;
}

export function reverseUnidentifiedReceiptResolution(resolutionId) {
  const database = activeWorkspaceDatabase();
  database.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = reverseUnidentifiedResolution(database, resolutionId, { actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  audit('reverse', 'unidentified_receipt', result.id, {});
  return result;
}
