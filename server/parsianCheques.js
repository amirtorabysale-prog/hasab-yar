// چک‌های بکاپ پارسیان (`tbl_Check`) در دفتر چک حساب‌یار.
//
// هر رویداد زندگی این چک‌ها — دریافت، وصول، واگذاری، برگشت، پاس — همین حالا سندی در
// دفتر دارد که از همان بکاپ آمده. پس ورود چک **هیچ سند تازه‌ای** نمی‌سازد: چک با
// وضعیتش ثبت می‌شود و به سند پارسیانِ خودش وصل می‌شود. چکی که هنوز در جریان است،
// حساب واقعی‌ای را که رویش نشسته (معین «اسناد دریافتنی» یا «اسناد پرداختنی» پارسیان)
// به یاد می‌سپارد تا وصول یا برگشتش در حساب‌یار همان حساب را ببندد، نه حساب چک خودِ
// حساب‌یار را (که آن‌وقت هر دو تا ابد باز می‌ماندند).
//
// معنای کد وضعیت (`Vos_Pas`) از سند پیوستهٔ هر چک اثبات شد (بکاپ اتیه سازان، ۷ آبان
// ۱۴۰۵): دریافتی ۰ در جریان، ۲ «وصول چک»، ۳ «واگذاری چک»، ۵ «برگشت چک»؛ پرداختی
// ۰ در جریان، ۷ «پاس چک»، ۸ «برگشت چک پرداختنی». کد دیگر حدس زده نمی‌شود: چک
// «نیازمند بررسی» می‌شود. تاریخ‌ها هم از سند اثبات شدند: ExpDate تاریخ ثبت، RecDate
// سررسید، Giv_Date تاریخ وصول یا واگذاری.

import { persianToISO } from '../shared/persianDate.js';
import { convertAmount } from '../shared/amountUnit.js';
import { ensureChequeSchema, logChequeEvent } from './db/cheques.js';
import { internalMoeenCode } from './parsianImport.js';

const STATUS_BY_CODE = Object.freeze({
  receivable: { 0: 'open', 2: 'cleared', 3: 'transferred', 5: 'bounced' },
  payable: { 0: 'open', 7: 'cleared', 8: 'bounced' },
});

const clean = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** تاریخ پارسیان (YYYY/MM/DD) به ISO؛ تاریخ خراب null. */
function parsianDate(value, timeZone) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(value || '').trim());
  return match ? persianToISO(Number(match[1]), Number(match[2]), Number(match[3]), timeZone) : null;
}

/**
 * چک‌های بکاپ را وارد دفتر چک می‌کند. اجرای دوباره چیزی را تکرار نمی‌سازد.
 * خروجی، علاوه بر شمارش، کنترل «جمع چک‌های در جریان = ماندهٔ اسناد دریافتنی/پرداختنی
 * در دفتر» را برمی‌گرداند؛ اختلاف صریح گفته می‌شود و عددی درست نمی‌شود.
 */
export function importParsianCheques(database, parsed, { fileUnit, ledgerUnit, analyticIdByKey = new Map(), timeZone = 'Asia/Tehran' } = {}) {
  ensureChequeSchema(database);
  const cheques = parsed?.extras?.cheques || [];
  const sha = parsed?.meta?.sha256 || '';
  const result = { imported: 0, existing: 0, byStatus: {}, review: 0, skipped: 0, controls: [], warnings: [] };
  if (!cheques.length) return result;

  const toLedger = (amount) => convertAmount(Math.round(Number(amount) || 0), fileUnit, ledgerUnit);
  // سندِ هر شمارهٔ پارسیان در همین ورود، با تاریخش؛ شماره در سال بعد تکرار می‌شود، پس
  // پیوند فقط وقتی است که تاریخ سند همان تاریخ چک باشد.
  const voucherDate = new Map(parsed.documents.rows.map((row) => [row.sanad, row.date]));
  const entryBySanad = new Map(database.prepare('SELECT sanad,entry_id AS entryId FROM parsian_imported_entries WHERE file_sha256=?')
    .all(sha).map((row) => [row.sanad, row.entryId]));
  const entryFor = (sanad, date) => (sanad > 0 && date && voucherDate.get(sanad) === date ? entryBySanad.get(sanad) || null : null);

  const chartLedger = database.prepare(`SELECT ledger_accounts.id FROM ledger_accounts JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    WHERE chart_accounts.code=? ORDER BY CASE WHEN ledger_accounts.source_kind='chart-account' THEN 0 ELSE 1 END,ledger_accounts.rowid LIMIT 1`);
  const chartByCode = database.prepare('SELECT id,name FROM chart_accounts WHERE code=?');
  const analyticName = database.prepare('SELECT name FROM analytic_accounts WHERE id=?');
  const party = (kol, moeen, taf) => {
    if (!kol) return { analyticId: null, chartId: null, name: '' };
    const chart = chartByCode.get(internalMoeenCode(kol, moeen));
    const analyticId = taf ? analyticIdByKey.get(`${kol}:${moeen}:${taf}`) || null : null;
    return { analyticId, chartId: chart?.id || null, name: (analyticId && analyticName.get(analyticId)?.name) || chart?.name || '' };
  };

  const insert = database.prepare(`INSERT OR IGNORE INTO cheques
    (id,direction,counterparty_name,amount,due_at,occurred_at,serial,bank_name,status,against,analytic_id,note,
     journal_entry_id,settled_entry_id,settled_at,source,source_key,sayad,note_account_id,party_chart_id,transferred_to,review_reason,
     bank_chart_id,bank_analytic_id)
    VALUES (?,?,?,?,?,?,?,?,?,'receivable',?,?,?,?,?,'parsian',?,?,?,?,?,?,?,?)`);
  // تاریخچه: ردیف‌های tbl_RecycleCheck وضعیت پیش از تغییر هر چک‌اند.
  const historyByCheque = new Map();
  for (const row of parsed.extras.chequeHistory || []) {
    if (!historyByCheque.has(row.chequeId)) historyByCheque.set(row.chequeId, []);
    historyByCheque.get(row.chequeId).push(row);
  }
  const statusOf = (direction, code) => STATUS_BY_CODE[direction][code] || 'review';
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of cheques) {
      const direction = row.kind === 1 ? 'payable' : row.kind === 0 ? 'receivable' : null;
      const amount = toLedger(row.money);
      if (!direction || !(amount > 0)) {
        result.skipped += 1;
        result.warnings.push(`چک ${row.serial || row.id} پارسیان ${direction ? 'مبلغ معتبر ندارد' : `نوع ناشناخته (${row.kind}) دارد`}؛ وارد نشد.`);
        continue;
      }
      const known = STATUS_BY_CODE[direction][row.status];
      // کد شناخته‌شده‌ای که با «فعال» پارسیان نمی‌خواند هم حدس زده نمی‌شود.
      const consistent = known && (row.active === null || (known === 'open') === row.active);
      const status = consistent ? known : 'review';
      const reviewReason = status === 'review'
        ? `وضعیت چک در پارسیان (کد ${row.status}${row.active === null ? '' : row.active ? '، فعال' : '، غیرفعال'}) شناخته نیست${row.settleSanad > 0 ? '' : ' و سند وصول، پاس یا واگذاری ندارد'}؛ حسابدار تکلیفش را روشن کند.`
        : '';
      const holder = party(row.accKol, row.accMoeen, row.accTaf);
      const note = row.tarafKol ? chartLedger.get(internalMoeenCode(row.tarafKol, row.tarafMoeen))?.id || null : null;
      const endorsee = status === 'transferred' ? party(row.bankKol, row.bankMoeen, row.bankTaf).name : '';
      const occurredAt = parsianDate(row.registeredDate, timeZone) || parsianDate(row.dueDate, timeZone);
      if (!occurredAt) { result.skipped += 1; result.warnings.push(`چک ${row.serial || row.id} پارسیان تاریخ معتبر ندارد؛ وارد نشد.`); continue; }
      const settledEntry = status === 'open' ? null : entryFor(row.settleSanad, row.settledDate);
      // چک پرداختی از بانک خودمان کشیده شده (Bank_K/M/T)؛ پاسش در حساب‌یار به همان بانک می‌نشیند.
      const drawnOn = direction === 'payable' && row.bankKol ? party(row.bankKol, row.bankMoeen, row.bankTaf) : null;
      const chequeId = `parsian-cheque:${sha.slice(0, 16)}:${row.id}`;
      const changes = insert.run(
        chequeId, direction, clean(holder.name) || 'نامشخص (پارسیان)', amount,
        parsianDate(row.dueDate, timeZone), occurredAt, clean(row.serial, 40), clean(row.bank, 100), status,
        holder.analyticId, clean(row.comment, 300), entryFor(row.sanad, row.registeredDate), settledEntry,
        status === 'open' ? null : parsianDate(row.settledDate, timeZone),
        String(row.id), clean(row.sayad, 30), note, holder.chartId, clean(endorsee), reviewReason,
        drawnOn?.chartId || null, drawnOn?.analyticId || null,
      ).changes;
      if (!changes) { result.existing += 1; continue; }
      const registeredEntry = entryFor(row.sanad, row.registeredDate);
      const history = historyByCheque.get(row.id) || [];
      for (const before of history) {
        const previous = party(before.accKol, before.accMoeen, before.accTaf);
        const movedHolder = before.accKol && (before.accKol !== row.accKol || before.accMoeen !== row.accMoeen);
        logChequeEvent(database, chequeId, {
          at: parsianDate(before.registeredDate, timeZone) || occurredAt, status: statusOf(direction, before.status),
          entryId: registeredEntry, source: 'parsian-history',
          note: `وضعیت پیشین در پارسیان (کد ${before.status})${movedHolder ? `؛ حساب صاحب چک آن زمان ${before.accKol}-${before.accMoeen}${previous.name ? ` (${clean(previous.name, 60)})` : ''}` : ''}`,
        });
      }
      if (!history.length) logChequeEvent(database, chequeId, { at: occurredAt, status: 'open', entryId: registeredEntry, source: 'parsian', note: direction === 'receivable' ? 'دریافت چک' : 'صدور چک' });
      if (status !== 'open') {
        logChequeEvent(database, chequeId, {
          at: parsianDate(row.settledDate, timeZone) || occurredAt, status, entryId: settledEntry, source: 'parsian',
          note: status === 'review' ? reviewReason : status === 'transferred' ? `واگذار به ${clean(endorsee)}` : `کد پارسیان ${row.status}`,
        });
      }
      result.history = (result.history || 0) + history.length;
      result.imported += 1;
      result.byStatus[`${direction}:${status}`] = (result.byStatus[`${direction}:${status}`] || 0) + 1;
      if (status === 'review') result.review += 1;
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  result.controls = chequeLedgerControls(database);
  for (const control of result.controls) {
    if (control.difference) result.warnings.push(`جمع چک‌های ${control.direction === 'receivable' ? 'دریافتی' : 'پرداختی'} در جریان روی «${control.accountName}» ${control.open.toLocaleString('en-US')} است ولی ماندهٔ همان حساب در دفتر ${control.balance.toLocaleString('en-US')}؛ اختلاف ${control.difference.toLocaleString('en-US')} را حسابدار بررسی کند.`);
  }
  return result;
}

/**
 * کنترل هر حساب اسناد: جمع چک‌های در جریانِ پارسیان روی آن حساب در برابر ماندهٔ همان
 * حساب در دفتر (پیش‌نویس‌های بکاپ هم، چون همهٔ سندهای بکاپ پیش‌نویس وارد می‌شوند).
 */
export function chequeLedgerControls(database) {
  ensureChequeSchema(database);
  return database.prepare(`SELECT cheques.note_account_id AS accountId,cheques.direction,ledger_accounts.name AS accountName,ledger_accounts.chart_account_id AS chartId,
      SUM(CASE WHEN cheques.status='open' THEN cheques.amount ELSE 0 END) AS open
    FROM cheques JOIN ledger_accounts ON ledger_accounts.id=cheques.note_account_id
    WHERE cheques.source='parsian' GROUP BY cheques.note_account_id,cheques.direction`).all().map((row) => {
    const net = Number(database.prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.chart_account_id=?`).get(row.chartId).net);
    const balance = row.direction === 'receivable' ? net : -net;
    return { accountId: row.accountId, accountName: row.accountName, direction: row.direction, open: Number(row.open), balance, difference: balance - Number(row.open) };
  });
}
