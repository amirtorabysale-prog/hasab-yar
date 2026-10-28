// سند چک‌های دریافتی و پرداختی.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { accountingError, ensureAccountingSchema, linkedLedgerAccount, operationalLedgerAccount, categoryLedgerAccount, counterpartyAccountKey, counterpartyLedgerAccount, periodForDate } from './ledgerAccounts.js';
import { nextRevision, insertJournal, assertAccountingPeriodOpen } from './journalCore.js';

// ---------------------------------------------------------------------------
// چک
// ---------------------------------------------------------------------------

/**
 * حساب اسناد دریافتنی و پرداختنی — به تفکیک صاحب چک.
 *
 * چک از مطالبات عادی جدا می‌ماند: سررسید دارد، ممکن است برگشت بخورد، و تا
 * وصول نشود پول نیست. ریختنش در همان حساب دریافتنی یعنی نه سررسیدی پیداست و
 * نه می‌شود گفت چقدر از مطالبات، چکِ در جریان است.
 *
 * ولی «جدا از مطالبات» یعنی حساب جدا، نه شخصِ گم‌شده. یک حساب مشترک برای
 * همهٔ چک‌ها، کارت حساب را خراب می‌کرد: مشتری‌ای که طلبش را با چک داده بود
 * در کارتش صفر می‌شد — انگار پول رسیده — درحالی‌که چک هنوز وصول نشده و او
 * همچنان بدهکار است. پس کلید همان کلیدی است که حساب دریافتنی‌اش دارد.
 */
export function chequeLedgerAccounts(database, counterparty = null) {
  ensureAccountingSchema(database);
  const name = String(counterparty?.name || '').trim().slice(0, 100);
  const receivableKey = name ? counterpartyAccountKey(database, 'cheque-receivable', counterparty?.contactId, name) : 'notes';
  const payableKey = name ? counterpartyAccountKey(database, 'cheque-payable', counterparty?.contactId, name) : 'notes';
  const label = (prefix) => (name ? `${prefix} — ${name}` : prefix);
  return {
    noteReceivable: linkedLedgerAccount(database, 'cheque-receivable', receivableKey, label('اسناد دریافتنی (چک)'), 'asset'),
    notePayable: linkedLedgerAccount(database, 'cheque-payable', payableKey, label('اسناد پرداختنی (چک)'), 'liability'),
  };
}

/**
 * سند هر سه مرحلهٔ زندگی یک چک.
 *
 * ثبت: چک دریافتی، اسناد دریافتنی را بدهکار می‌کند. طرف دیگرش بستگی دارد به
 * اینکه چک بابت فروش تازه باشد (درآمد) یا بابت طلب قبلی (حساب دریافتنی).
 * دومی حیاتی است: آن فروش قبلاً درآمد شده و شناسایی دوباره‌اش یعنی همان مبلغ
 * دو بار در سود دوره و دو بار در مالیات.
 *
 * وصول: پول واقعاً می‌آید — نقد بدهکار، اسناد دریافتنی بستانکار. نه درآمدی
 * ساخته می‌شود و نه هزینه‌ای.
 *
 * برگشت: طلب از بین نرفته، فقط ابزارش باطل شده — مبلغ از اسناد دریافتنی به
 * حساب دریافتنیِ همان شخص برمی‌گردد و او دوباره بدهکار می‌شود.
 *
 * واگذاری (فقط چک دریافتی): چک مشتری به تأمین‌کننده داده می‌شود. پولی از حساب
 * شرکت جابه‌جا نمی‌شود؛ بدهی ما به گیرنده کم می‌شود و اسناد دریافتنی بسته می‌شود.
 */
export function postChequeJournal(database, values, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(values.amount) || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ چک معتبر نیست.', 'CHEQUE_AMOUNT_INVALID');
  const stage = values.stage || 'record';
  const receivable = values.direction === 'receivable';
  const occurredAt = values.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));

  const party = values.counterparty || {};
  // چکِ واردشده از پارسیان روی حساب اسناد و حساب طرفِ خودِ پارسیان نشسته؛ وصول و برگشتش
  // باید همان‌ها را ببندد، نه حساب چکِ ساختهٔ حساب‌یار.
  const noteAccount = values.noteAccountId || (() => {
    const notes = chequeLedgerAccounts(database, party);
    return receivable ? notes.noteReceivable : notes.notePayable;
  })();
  const analyticId = party.analyticId || null;
  const partyAccount = () => values.partyAccountId || counterpartyLedgerAccount(database, party.contactId, party.name, receivable ? 'sales' : 'purchase');

  let lines;
  if (stage === 'record') {
    // خرید کالا برای فروش یا تولید با چک: موجودی تفکیک‌نشده، نه هزینه.
    const other = values.against === 'receivable'
      ? partyAccount()
      : !receivable && values.inventory
        ? linkedLedgerAccount(database, 'inventory-unsplit', 'unsplit', 'موجودی کالا — تفکیک‌نشده', 'asset')
        : categoryLedgerAccount(database, receivable ? 'income' : 'expense', values.category);
    // تفصیلی فقط روی سطری می‌نشیند که واقعاً مال یک شخص است؛ روی حساب درآمد
    // و هزینه معنایی ندارد.
    const otherAnalytic = values.against === 'receivable' ? analyticId : null;
    lines = receivable
      ? [{ accountId: noteAccount, debit: amount, analyticId }, { accountId: other, credit: amount, analyticId: otherAnalytic }]
      : [{ accountId: other, debit: amount, analyticId: otherAnalytic }, { accountId: noteAccount, credit: amount, analyticId }];
  } else if (stage === 'clear') {
    const cash = operationalLedgerAccount(database, values.cashAccountId || 'cash');
    lines = receivable
      ? [{ accountId: cash, debit: amount }, { accountId: noteAccount, credit: amount, analyticId }]
      : [{ accountId: noteAccount, debit: amount, analyticId }, { accountId: cash, credit: amount }];
  } else if (stage === 'transfer') {
    if (!receivable) throw accountingError('فقط چک دریافتی واگذار می‌شود.', 'CHEQUE_TRANSFER_PAYABLE');
    const endorsee = values.endorsee || {};
    if (!endorsee.accountId) throw accountingError('حساب گیرندهٔ چک معلوم نیست.', 'CHEQUE_ENDORSEE_MISSING');
    lines = [{ accountId: endorsee.accountId, debit: amount, analyticId: endorsee.analyticId || null }, { accountId: noteAccount, credit: amount, analyticId }];
  } else {
    const party_ = partyAccount();
    lines = receivable
      ? [{ accountId: party_, debit: amount, analyticId }, { accountId: noteAccount, credit: amount, analyticId }]
      : [{ accountId: noteAccount, debit: amount, analyticId }, { accountId: party_, credit: amount, analyticId }];
  }

  return insertJournal(database, {
    sourceType: `cheque_${stage}`, sourceId: values.chequeId,
    revision: nextRevision(database, `cheque_${stage}`, values.chequeId),
    occurredAt, memo: String(values.memo || 'چک').slice(0, 200), createdBy, timeZone,
    lines: lines.map((line) => ({ ...line, description: values.memo || '' })),
  });
}
