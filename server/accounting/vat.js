// ارزش افزوده: مانده‌ها، تسویهٔ دوره و مطالبهٔ استرداد.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { accountingError, ensureAccountingSchema, linkedLedgerAccount, operationalLedgerAccount, outputTaxLedgerAccount, inputTaxLedgerAccount, periodForDate } from './ledgerAccounts.js';
import { insertJournal, assertAccountingPeriodOpen } from './journalCore.js';
import { unitLabel } from '../../shared/amountUnit.js';

// ---------------------------------------------------------------------------
// تسویهٔ دورهٔ مالیات بر ارزش افزوده
// ---------------------------------------------------------------------------

/**
 * ماندهٔ دو حساب ارزش افزوده.
 *
 * فروش بستانکار است (بدهی به سازمان) و خرید بدهکار (اعتبار). گزارش مالیاتی
 * از فاکتورها ساخته می‌شود ولی تسویه باید از **دفتر** بیاید: همان مانده‌ای
 * که واقعاً در حساب نشسته، نه چیزی که دوباره از فاکتورها حساب شود.
 */
export function vatBalances(database) {
  ensureAccountingSchema(database);
  const balance = (accountId) => (accountId ? Number(database.prepare(
    'SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines WHERE account_id=?',
  ).get(accountId).net || 0) : 0);
  // فقط خواندن: ساختن حساب کار ثبت سند است، نه کار گزارش.
  const find = (key) => database.prepare("SELECT id FROM ledger_accounts WHERE source_kind='system' AND source_key=?").get(key)?.id || null;
  const output = find('output-tax');
  const input = find('input-tax');
  return {
    outputAccountId: output, inputAccountId: input,
    // ماندهٔ فروش بستانکار است، پس با علامت مثبت گزارش می‌شود. جمع با صفر،
    // «منفی صفر» را برمی‌دارد — وگرنه در رابط «−۰» نوشته می‌شود.
    outputTax: -balance(output) + 0,
    inputTax: balance(input) + 0,
  };
}

/**
 * تسویهٔ دورهٔ ارزش افزوده.
 *
 * بدون این، دو حساب ارزش افزوده تا ابد بزرگ می‌شوند: بدهی به سازمان و
 * اعتبار خرید هیچ‌وقت خنثی نمی‌شوند و ترازنامه هر دو را باد می‌کند. بدتر،
 * وقتی شرکت واقعاً مالیات را می‌پردازد، آن پرداخت جایی جز «هزینه» نمی‌نشیند
 * — و ارزش افزوده هزینهٔ شرکت نیست، پول سازمان است که شرکت فقط جمعش کرده.
 *
 * اعتبار اضافی منتقل می‌شود، نه مطالبه: اگر اعتبار خرید از بدهی فروش بیشتر
 * باشد فقط به اندازهٔ بدهی خنثی می‌شود و باقی‌اش برای دورهٔ بعد می‌ماند —
 * همان کاری که در عمل انجام می‌شود.
 */
export function postVatSettlementJournal(database, { settlementId, occurredAt, cashAccountId, memo }, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  const { outputTax, inputTax } = vatBalances(database);
  if (outputTax <= 0) throw accountingError('بدهی ارزش افزودهٔ تسویه‌نشده‌ای در دفتر نیست.', 'VAT_NOTHING_TO_SETTLE');
  // اینجا حساب حتماً وجود دارد (ماندهٔ مثبت دارد)، ولی گرفتنش از همان تابعی
  // که سند هم از آن می‌گیرد، یک منبع می‌ماند.
  const outputAccountId = outputTaxLedgerAccount(database);
  const inputAccountId = inputTaxLedgerAccount(database);
  const offset = Math.min(outputTax, inputTax);
  const payable = outputTax - offset;
  const at = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(at, timeZone));

  const lines = [{ accountId: outputAccountId, debit: outputTax, description: 'بستن مالیات فروش دوره' }];
  if (offset > 0) lines.push({ accountId: inputAccountId, credit: offset, description: 'استفاده از اعتبار مالیات خرید' });
  if (payable > 0) {
    lines.push({ accountId: operationalLedgerAccount(database, cashAccountId || 'cash'), credit: payable, description: 'پرداخت مالیات ارزش افزوده' });
  }
  const posted = insertJournal(database, {
    sourceType: 'vat_settlement', sourceId: settlementId, revision: 1,
    occurredAt: at, memo: String(memo || 'تسویهٔ دورهٔ ارزش افزوده').slice(0, 200), createdBy, timeZone, lines,
  });
  return { ...posted, outputTax, inputTax, offset, paid: payable, carriedForward: inputTax - offset };
}

// ---------------------------------------------------------------------------
// طلب استرداد ارزش افزوده
// ---------------------------------------------------------------------------

/**
 * مبلغی که دفتر واقعاً می‌تواند از سازمان طلب کند.
 *
 * دو منبع دارد و فقط این دو: اعتبار خریدی که پس از خنثی شدن با مالیات فروش
 * اضافه مانده، و پرداختی بیش از بدهی ثبت‌شده (ماندهٔ بدهکار روی حساب مالیات
 * فروش). هر چیزی بیرون از این دو، طلب فرضی است.
 */
export function vatRefundClaimable(database) {
  const { outputTax, inputTax } = vatBalances(database);
  const fromInput = Math.max(0, inputTax - Math.max(outputTax, 0));
  const fromOverpayment = Math.max(0, -outputTax);
  return { fromInput, fromOverpayment, total: fromInput + fromOverpayment };
}

export function taxReceivableLedgerAccount(database) {
  return linkedLedgerAccount(database, 'tax-receivable', 'vat-refund', 'مطالبات مالیاتی — استرداد ارزش افزوده', 'asset');
}

/**
 * ثبت طلب استرداد — سند مبنایی که وصول بعدی به آن وصل می‌شود.
 *
 * تسویهٔ دوره اعتبار اضافه را روی «اعتبار خرید» نگه می‌دارد تا دورهٔ بعد
 * مصرف شود. وقتی شرکت به‌جای انتقال، استرداد می‌خواهد، همان مبلغ از اعتبار
 * خرید (یا از اضافه‌پرداخت) به «مطالبات مالیاتی» منتقل می‌شود. بدون این سند،
 * وصول استرداد هیچ طلبی برای بستن پیدا نمی‌کرد و فقط دو راه غلط می‌ماند:
 * درآمد تازه، یا کم کردن اعتباری که شاید مال دورهٔ جاری باشد.
 *
 * شمارهٔ اظهارنامه یا درخواست اجباری است؛ همان در شرح سند می‌نشیند و
 * حسابدار با آن سند را در وصول انتخاب می‌کند.
 */
export function postVatRefundClaimJournal(database, { claimId, amount, occurredAt, reference, memo }, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  const value = Math.round(Number(amount) || 0);
  if (!Number.isSafeInteger(value) || value <= 0) throw accountingError('مبلغ طلب استرداد معتبر نیست.', 'VAT_CLAIM_AMOUNT_INVALID');
  const ref = String(reference || '').trim().slice(0, 80);
  if (ref.length < 2) throw accountingError('شمارهٔ اظهارنامه یا درخواست استرداد را بنویس؛ وصول بعدی با همین شماره به این طلب وصل می‌شود.', 'VAT_CLAIM_REFERENCE_REQUIRED');
  const claimable = vatRefundClaimable(database);
  if (value > claimable.total) {
    throw accountingError(`مبلغ از ماندهٔ قابل استرداد دفتر بیشتر است؛ حداکثر ${claimable.total.toLocaleString('fa-IR')} ${unitLabel()}.`, 'VAT_CLAIM_EXCEEDS_BALANCE', 409);
  }
  const at = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(at, timeZone));
  // اول اعتبار خرید، بعد اضافه‌پرداخت: ترتیب فقط شرح سطرها را تعیین می‌کند،
  // جمع همیشه همان مبلغ است.
  const fromInput = Math.min(value, claimable.fromInput);
  const fromOverpayment = value - fromInput;
  const text = String(memo || `طلب استرداد ارزش افزوده — ${ref}`).slice(0, 200);
  const lines = [{ accountId: taxReceivableLedgerAccount(database), debit: value, description: text }];
  if (fromInput > 0) lines.push({ accountId: inputTaxLedgerAccount(database), credit: fromInput, description: 'انتقال اعتبار خرید به طلب استرداد' });
  if (fromOverpayment > 0) lines.push({ accountId: outputTaxLedgerAccount(database), credit: fromOverpayment, description: 'انتقال اضافه‌پرداخت به طلب استرداد' });
  const posted = insertJournal(database, {
    sourceType: 'vat_refund_claim', sourceId: claimId, revision: 1,
    occurredAt: at, memo: text, createdBy, timeZone, lines,
  });
  return { ...posted, amount: value, reference: ref, fromInput, fromOverpayment };
}
