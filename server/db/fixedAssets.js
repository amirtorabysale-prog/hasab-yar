import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace } from './core.js';
import { listFixedAssets, runDepreciation, saveFixedAssetSettings } from '../depreciationLedger.js';
import { persianMonthRange } from '../../shared/persianDate.js';

// ---------------------------------------------------------------------------
// دارایی ثابت و استهلاک
// ---------------------------------------------------------------------------

/**
 * ماه شمسی جاری به شکل «YYYY-MM»، همان قالبی که جدول استهلاک با آن کار می‌کند.
 */
function currentPersianMonthKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone: currentTimeZone(), year: 'numeric', month: '2-digit' })
    .formatToParts(now).filter((part) => part.type !== 'literal');
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}`;
}

export function fixedAssetOverview({ throughMonth = '', now = new Date() } = {}) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(throughMonth) ? throughMonth : currentPersianMonthKey(now);
  return { throughMonth: month, items: listFixedAssets(activeWorkspaceDatabase(), { throughMonth: month }) };
}

export function saveFixedAsset(values = {}) {
  const item = saveFixedAssetSettings(activeWorkspaceDatabase(), values);
  audit('update', 'fixed-asset', values.assetKey, {
    usefulLifeMonths: values.usefulLifeMonths, salvage: values.salvage, inServiceMonth: values.inServiceMonth,
  });
  return item;
}

/**
 * سند استهلاک روی **آخرین روز** هر ماه شمسی می‌نشیند، نه روز اجرا.
 * استهلاک هزینهٔ همان ماه است؛ نشاندنش روی روز اجرا، هزینه را به ماه دیگری
 * می‌برد و سود هر دو ماه را غلط می‌کند.
 */
export function postDepreciation({ throughMonth = '', now = new Date() } = {}) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(throughMonth) ? throughMonth : currentPersianMonthKey(now);
  const timeZone = currentTimeZone();
  const result = runDepreciation(activeWorkspaceDatabase(), {
    throughMonth: month,
    timeZone,
    createdBy: currentWorkspace()?.userId || null,
    occurredAtFor: (value) => {
      const [year, index] = value.split('-').map(Number);
      return persianMonthRange(year, index, timeZone)?.to || null;
    },
  });
  if (result.posted) audit('post', 'depreciation', month, { posted: result.posted, amount: result.amount });
  return result;
}
