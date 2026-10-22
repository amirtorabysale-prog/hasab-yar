// ثبت ردیف‌ها از گفته یا فرم: مسیر رویداد مالی، تعهد فهمیده‌شده، آورده و دارایی ثابت، انتقال با کارمزد، و خرجی که شریک داده.
//
// از server/db/transactions.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// transactions همه از همان server/db/transactions.js می‌خوانند.

import { asFundedSpend, detectPartnerFundedSpend, detectPartnerPaidDebt } from '../../../shared/partnerPaidSpeech.js';
import { randomUUID } from 'node:crypto';
import { accountForBank, resolveAccountId, transferBetweenAccounts } from '../accounts.js';
import { audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from '../core.js';
import { assertAccountingPeriodOpen, periodForDate, postCapitalJournal, syncTransactionJournal } from '../../accounting.js';
import { automationPolicy } from '../settings.js';
import { normalizeTopicLabel } from '../../chartOfAccounts.js';
import { COMPOSITE_AMOUNT_MESSAGE, hasCompositeAmounts, describesUnperformedCondition, UNPERFORMED_CONDITION_MESSAGE } from '../../../shared/parser.js';
import { priorSettlementDirection } from '../../../shared/priorSettlement.js';
import { contactIdForName } from '../contacts.js';
import { approveFinancialEvent, recordFinancialEvent, recordShadowRun } from '../../financialEventStore.js';
import { openDocumentsFor } from '../counterpartyCard.js';
import { transactionEventDecision } from '../../transactionEvent.js';
import { vatGuardContext } from '../../tax.js';
import { NATURE_EXPLANATIONS, readExplicitNonCash, readMixedSettlement, MIXED_SETTLEMENT_REASON } from '../../../shared/eventNature.js';
import { normalizeFinancialEvent } from '../../../shared/financialEvent.js';
import { ROUTES } from '../../../shared/confidenceEngine.js';
import { CAPITAL_FLOWS, CAPITAL_IN_CATEGORY, FIXED_ASSET_CATEGORY_PREFIX, normalizeReviewState, jsonText, transactionJournalPoster, settlementFor } from './rows.js';
import { counterpartyFromSentence, correctionNature, NON_CASH_REASON, nonCashInstrument, queueCorrectionForAccountant, openNonCashStatement, queueUnmatchedSettlement } from './sentenceChecks.js';

/**
 * عبور دادن یک تراکنش از موتور اطمینان.
 *
 * برمی‌گرداند: آیا لایهٔ رویداد مسئولیت سند را گرفت؟ اگر نه، فراخوان باید مثل
 * قبل خودش سند بزند.
 *
 * اگر موتور نسخهٔ دو روشن است، شکست این لایه ثبت را متوقف می‌کند؛ بازگشت
 * خودکار به سند قدیمی می‌تواند یک پیش‌پرداخت یا تسویه را هزینه/درآمد کند.
 */
function routeTransactionThroughEvents(row, item, transcript, sentence = '') {
  try {
    const settlement = settlementFor(row);
    const draft = transactionEventDecision({
      ...item, amount: row.amount, occurredAt: row.occurredAt, accountId: row.accountId, rawText: row.rawText,
      contactId: row.contactId, contactName: settlement?.contactName || item.contactName || '',
    }, { transcript, sentence, policy: automationPolicy(), counterpartyBalance: settlement?.balance ?? null });
    if (!draft) return false;
    // ضبط شادو پیش از هر ثبتی و مستقل از نتیجه‌اش: مواردی که موتور جلویشان را
    // می‌گیرد بیشترین ارزش را برای گزارش اختلاف دارند.
    const shadow = automationPolicy().shadowMode && draft.accountingDecision;
    if (shadow) {
      try {
        recordShadowRun(db, {
          event: draft.event, decision: draft.accountingDecision,
          confidence: draft.decision, sourceEventId: `transaction:${row.id}`,
        });
      } catch { /* ضبط شادو نباید ثبت کاربر را از بین ببرد. */ }
    }
    let result = recordFinancialEvent(db, draft.event, {
      sourceEventId: `transaction:${row.id}`,
      decision: draft.decision,
      actor: currentWorkspace()?.userId || null,
      transcript,
      rawInput: row.rawText || transcript,
      timeZone: currentTimeZone(),
      withinTransaction: true,
      journalSource: { type: 'transaction', id: row.id },
      postJournal: transactionJournalPoster(row, settlement),
      // در شادو مود، تصمیم **پاس داده نمی‌شود**.
      //
      // این تنها چیزی است که وعدهٔ «دفتر دست نمی‌خورد» را واقعی می‌کند: تصمیم
      // ضبط شده، ولی نگهبان‌ها و نقشهٔ موتور روی ثبت اثر نمی‌گذارند و سند
      // دقیقاً همان‌طور می‌خورد که تا امروز می‌خورده. بدون این، شادو مود فقط
      // یک لایهٔ ضبط روی موتورِ فعال بود و هیچ‌کس نمی‌توانست بی‌ریسک روشنش کند.
      accountingDecision: shadow ? null : (draft.accountingDecision || null),
      // `undefined` وقتی طرف حساب شناسایی نشده: نگهبان باید بتواند بگوید
      // «نتوانستم بررسی کنم»، نه اینکه سکوت کند.
      openDocuments: row.contactId ? openDocumentsFor(row.contactId) : undefined,
      // فقط وقتی موتور روشن است خوانده می‌شود؛ بدون تصمیم، نگهبانی اجرا نمی‌شود.
      vat: draft.accountingDecision ? vatGuardContext(db) : undefined,
    });
    // Confirmation of the displayed draft is distinct from model confidence.
    // Recompute and persist guards first; never approve a structural blocker.
    if (item.userConfirmed === true && result.status === 'pending'
      && result.route === ROUTES.CONFIRM && !draft.decision.reasons.length
      && (!draft.accountingDecision || draft.accountingDecision.decisionStatus === 'decided')) {
      result = approveFinancialEvent(db, result.id, {
        actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
        postJournal: transactionJournalPoster(row, settlement), withinTransaction: true,
      });
    }
    // مسیر غیرخودکار یعنی سند منتظر می‌ماند. ردیف تراکنش سر جایش است — کاربر
    // ثبتش را می‌بیند و ماندهٔ صندوقش درست است — ولی دفتر تا تأیید تکان نمی‌خورد.
    if (result.status !== 'posted') {
      db.prepare('UPDATE transactions SET journal_deferred=1 WHERE id=?').run(row.id);
    }
    return true;
  } catch (error) {
    if (automationPolicy().engineV2) throw error;
    return false;
  }
}

/**
 * بخش نسیهٔ یک رویداد فهمیده‌شده: همان مسیر «پولی جابه‌جا نشده» با واقعیت‌های صریح.
 * فراخوان خودش تراکنش SQLite را باز کرده است.
 */
export function recordUnderstoodObligation(item, transcript) {
  return openNonCashStatement(item, transcript, transcript);
}

// `fromUtterance` فقط از مسیر عمومی ثبت (گفته یا متن کاربر) روشن است. مسیرهای
// داخلی — رسید، صورت‌حساب بانک، تسویهٔ تعهد، فاکتور، تکرار — متن خودشان را
// می‌سازند («واریز چک»، «شماره چک» در رسید) و شناسهٔ ردیف ساخته‌شده را لازم
// دارند؛ صف کردنشان بدون ردیف آن مسیرها را می‌شکست.
export function insertTransactionRows({ transcript, transactions, counterpartyResolution = '', fromUtterance = false }) {
  const insert = db.prepare(`INSERT OR IGNORE INTO transactions
    (id,client_id,amount,type,category,raw_text,source,confidence,needs_review,confidence_details,review_reasons,review_state,restored_from,capital_flow,occurred_at,contact_id,account,account_id,note,status,due_at,updated_at,settlement_choice,topic_label)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  let queuedForAccountant = 0;
  const queuedReasons = [];
  // طلب و بدهی‌هایی که از جملهٔ بدون جابه‌جایی پول ساخته شدند.
  const nonCash = [];
  // بدهی شرکت که شریک از پول شخصی‌اش داد هیچ ردیف نقدی ندارد. کارت تسویه
  // مسیر درست است؛ اگر گفته از آن رد نشده (کلاینت قدیمی، آفلاین)، به‌جای
  // پرداخت یا دریافتِ صندوق، با سند پیشنهادی به صف حسابدار می‌رود.
  // هزینه یا خریدی که شریک یا کارمند از پول شخصی‌اش داد: همان تصمیم موتور، بی
  // ردیف نقدی، با منبع پولِ درست (جاری شریک یا پرداختنیِ کارمند).
  const funder = fromUtterance && transactions.length ? detectPartnerFundedSpend(transcript) : null;
  const funded = (item) => item.fundedBy || funder;
  if (transactions.length && transactions.every((item) => funded(item) && (item.type === 'expense' || !item.fundedBy))) {
    for (const item of transactions) {
      const recorded = recordFundedSpend(item, transcript, transactions.length === 1 ? transcript : '', funded(item));
      nonCash.push({ eventId: recorded.id, status: recorded.status, route: recorded.route, fundedBy: funded(item).kind });
      if (recorded.status !== 'posted') {
        queuedForAccountant += 1;
        queuedReasons.push(`از پول شخصی ${funded(item).name || funded(item).role || 'پرداخت‌کننده'} پرداخت شده؛ از صندوق کم نشد و سندش با حسابدار است.`);
      }
    }
    return Object.assign(ids, { queuedForAccountant, queuedReasons, nonCash });
  }
  if (fromUtterance && transactions.length && detectPartnerPaidDebt(transcript)) {
    queueUnmatchedSettlement(transcript, { clientId: transactions[0]?.clientId || '', source: transactions[0]?.source });
    return Object.assign(ids, { queuedForAccountant: 1, queuedReasons: ['بدهی شرکت از پول شخصی شریک پرداخت شده؛ از صندوق و بانک وجهی نرفته. با سند پیشنهادی به صف حسابدار رفت.'] });
  }
  // «اشتباه ۲۱ میلیون ثبت شد، درست ۱۲ میلیون است» دو مبلغ است اما فقط یک
  // درخواست اصلاح. چند ردیف صف با مبالغ متناقض می‌تواند دو اصلاح مستقل بسازد.
  const correction = fromUtterance && transactions.length > 1 && correctionNature(transactions[0], transcript);
  if (correction) {
    const corrected = /مبلغ\s+درست|صحیح|باید/.test(String(transcript || ''))
      ? transactions[transactions.length - 1] : transactions[0];
    queueCorrectionForAccountant(corrected, transcript, correction);
    return Object.assign(ids, { queuedForAccountant: 1, queuedReasons: [NATURE_EXPLANATIONS[correction] || 'اصلاح یک ثبت قبلی'] });
  }
  for (const item of transactions) {
    // پولی که هنوز جابه‌جا نشده («قراره تا آبان پرداختش کنیم»، «موعد پرداختش هفته بعده»، «مشتری
    // هنوز نداده») ردیف نقدی نمی‌سازد، از هر مسیری که آمده باشد. تا ۲۹ مهر ۱۴۰۵ فقط «نسیه»ِ صریح
    // به این مسیر می‌رسید؛ ردیفِ `unpaidSignal` با حساب صندوق ذخیره می‌شد، رویدادش «بدهی باز» بود
    // و پس از تأیید، ماندهٔ صندوق را به اندازهٔ بدهیِ پرداخت‌نشده کم می‌کرد (دیده‌شده در صف حسابدار).
    const unpaid = item.unpaidSignal === true && ['income', 'expense'].includes(item.type);
    const nature = (fromUtterance
      ? correctionNature(item, transcript) || (nonCashInstrument(item, transcript) ? 'non-cash-instrument' : null) || (readMixedSettlement(transcript || item.rawText) ? 'mixed-settlement' : null) || (readExplicitNonCash(transcript || item.rawText) ? 'explicit-non-cash' : null)
      : null) || (unpaid ? 'explicit-non-cash' : null);
    if (nature) {
      const amount = Math.round(Number(item.amount));
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw invalidInput('مبلغ معتبر نیست.');
      if (nature === 'explicit-non-cash' && automationPolicy().engineV2 && ['income', 'expense'].includes(item.type)) {
        const opened = openNonCashStatement(item, transcript, transactions.length === 1 ? transcript : '');
        if (opened) {
          nonCash.push({ obligationId: opened.obligationId, eventId: opened.id, status: opened.status, route: opened.route, question: opened.question?.text || null });
          if (opened.route === ROUTES.ACCOUNTANT_REVIEW && opened.status !== 'posted') {
            queuedForAccountant += 1;
            queuedReasons.push('وجهی جابه‌جا نشده؛ طلب یا بدهی ساخته شد و ثبتش با حسابدار است.');
          }
          continue;
        }
      }
      queueCorrectionForAccountant(item, transcript, nature);
      queuedForAccountant += 1;
      queuedReasons.push(nature === 'mixed-settlement' ? MIXED_SETTLEMENT_REASON : nature === 'non-cash-instrument' ? NON_CASH_REASON : nature === 'explicit-non-cash' ? 'وجهی جابه‌جا نشده؛ ثبت نقدی ساخته نشد.' : (NATURE_EXPLANATIONS[nature] || ''));
      continue;
    }
    const id = randomUUID();
    const amount = Math.round(Number(item.amount));
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw invalidInput('مبلغ معتبر نیست.');
    if (!['income', 'expense'].includes(item.type)) throw invalidInput('نوع تراکنش معتبر نیست.');
    const occurredAt = item.occurredAt || new Date().toISOString();
    assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
    const accountId = resolveAccountId(item);
    // کاربر روی برگه گفته این ثبت طرف حساب ندارد؛ نامی که شنیده شده هم
    // نباید پشت سرش کارت حساب بسازد.
    const contactId = item.linkContact === false
      ? null
      : item.contactId || counterpartyFromSentence(item, transcript, counterpartyResolution);
    // بانکی که گفته شده ولی حسابی در دفتر ندارد، بی‌صدا روی صندوق می‌نشیند.
    // این همان خطایی است که کاربر هیچ‌وقت نمی‌بیند و آخر ماه ماندهٔ صندوق و
    // بانک هر دو غلط است — پس به‌جای سکوت، سؤال می‌شود.
    const bankSaidButUnknown = item.bankId && !item.accountId && !item.account && !accountForBank(item.bankId);
    // دلیلِ تنها کافی نیست: ثبتی که «آماده» علامت بخورد هیچ‌جا دیده
    // نمی‌شود و همان سکوتی می‌ماند که قرار بود بشکند. کاربر نام بانک را
    // گفته و ثبت روی صندوق نشسته؛ این باید به چشمش بیاید.
    const entry = bankSaidButUnknown
      ? { ...item, needsReview: true, reviewReasons: [...(Array.isArray(item.reviewReasons) ? item.reviewReasons : []),
        `حسابی برای «${item.bankName || 'این بانک'}» تعریف نشده؛ فعلاً روی حساب پیش‌فرض نشسته است.`] }
      : item;
    const reviewState = normalizeReviewState(entry.reviewState, entry.needsReview ? 'review' : 'ready');
    const result = insert.run(
      id, item.clientId || null, amount, item.type, String(item.category || 'سایر').slice(0, 80),
      String(item.rawText || transcript || '').slice(0, 1000), item.source || 'text', Number(item.confidence ?? 1),
      entry.needsReview ? 1 : 0, jsonText(entry.confidenceDetails, {}), jsonText(entry.reviewReasons, []), reviewState,
      item.restoredFrom || null, CAPITAL_FLOWS.includes(item.capitalFlow) ? item.capitalFlow : '',
      occurredAt, contactId || null, accountId, accountId,
      String(item.note || '').slice(0, 500), item.status || 'confirmed', item.dueAt || null, occurredAt,
      ['none', 'payable', 'receivable'].includes(item.settlement) ? item.settlement : '',
      // برچسب موضوعیِ فهم رویداد (طرح ترکیبی): روی سطر دسته تفصیلی می‌شود.
      normalizeTopicLabel(item.topicLabel) || '',
    );
    if (result.changes) {
      ids.push(id);
      audit('create', 'transaction', id, { amount, type: item.type, category: item.category });
      if (!item.journalManaged) {
        // شناسهٔ طرف حساب هم می‌رود: بدون آن، سند هرگز نمی‌فهمد این پرداخت
        // تسویهٔ بدهی همان شخص است و همیشه روی دستهٔ هزینه می‌نشیند.
        const row = { id, amount, type: item.type, category: item.category, rawText: item.rawText || transcript, accountId, occurredAt, contactId: contactId || null, settlement: item.settlement || null, topicLabel: normalizeTopicLabel(item.topicLabel) || '' };
        // اگر لایهٔ رویداد کار را به عهده گرفت، سند اینجا زده نمی‌شود؛ یا خودش
        // زده یا عمداً نگه داشته است.
        // جملهٔ کامل فقط وقتی شاهد همین ردیف است که جمله یک ردیف بیشتر نساخته.
        // `rawText` فقط تکهٔ کنار مبلغ است و در «ارزش افزودهٔ فصل رو ۲۰ میلیون
        // دادم» به «دادم» کوتاه می‌شود؛ ولی در جملهٔ چندمبلغی، ارزش افزودهٔ یک
        // ردیف نباید به ردیف دیگر بچسبد.
        const sentence = transactions.length === 1 ? transcript : '';
        if (!routeTransactionThroughEvents(row, entry, transcript, sentence)) {
          syncTransactionJournal(db, row, { createdBy: currentWorkspace()?.userId, settlement: settlementFor(row) });
        }
      }
    } else if (item.clientId) {
      const existing = db.prepare('SELECT id FROM transactions WHERE client_id=?').get(item.clientId);
      if (existing) ids.push(existing.id);
    }
  }
  // تعداد اصلاح‌هایی که به‌جای ردیف نقدی به صف حسابدار رفتند، کنار شناسه‌ها.
  return Object.assign(ids, { queuedForAccountant, queuedReasons, nonCash });
}

/**
 * ثبت آوردهٔ سرمایه یا خرید دارایی ثابت.
 *
 * چرا از مسیر تراکنش عبور می‌کند و سند دستی نیست: ماندهٔ صندوق و کنترل پایان
 * روز از ردیف‌های `transactions` ساخته می‌شوند. سندِ فقط-دفترکل، پول را در دفتر
 * جابه‌جا می‌کرد ولی موجودی صندوق برنامه دست‌نخورده می‌ماند و کاربر پایان روز یک
 * اختلاف بی‌دلیل می‌دید.
 *
 * و چرا `capital_flow` لازم است: ردیف تراکنش فقط دو نوع دارد، درآمد و هزینه.
 * بدون این نشانه، آورده در جمع درآمد ماه می‌نشست و خرید دارایی در جمع هزینه.
 * سند دفتر کل هم عمداً از مسیر دستهٔ درآمد/هزینه رد نمی‌شود؛ `journalManaged`
 * سند خودکار را خاموش می‌کند و `postCapitalJournal` سند درست را می‌زند.
 */
export function recordCapitalEntry(values = {}) {
  const kind = CAPITAL_FLOWS.includes(values.kind) ? values.kind : null;
  if (!kind) throw invalidInput('نوع ثبت سرمایه معتبر نیست.');
  const amount = cleanAmount(values.amount);
  if (amount <= 0) throw invalidInput('مبلغ را وارد کن.');
  const title = String(values.title || '').trim().slice(0, 100);
  if (!title) throw invalidInput(kind === 'capital-in' ? 'عنوان آورده را وارد کن.' : 'نام دارایی ثابت را وارد کن.');
  const occurredAt = values.occurredAt || new Date().toISOString();
  const accountId = resolveAccountId(values);
  const note = String(values.note || '').slice(0, 500);
  db.exec('BEGIN IMMEDIATE');
  try {
    const [id] = insertTransactionRows({ transcript: note || title, transactions: [{
      amount, type: kind === 'capital-in' ? 'income' : 'expense',
      category: kind === 'capital-in' ? CAPITAL_IN_CATEGORY : `${FIXED_ASSET_CATEGORY_PREFIX}${title}`,
      rawText: note || title, source: values.source === 'voice' ? 'voice' : 'text',
      occurredAt, accountId, note, status: 'confirmed', journalManaged: true, capitalFlow: kind,
    }] });
    postCapitalJournal(db, { transactionId: id, kind, amount, accountId, title, occurredAt },
      { createdBy: currentWorkspace()?.userId });
    audit('create', 'capital-entry', id, { kind, amount, title });
    db.exec('COMMIT');
    return { id, kind, amount, title, accountId, occurredAt };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function insertTransactions(payload) {
  if (hasCompositeAmounts(payload.transcript)) throw invalidInput(COMPOSITE_AMOUNT_MESSAGE);
  // کاری که هنوز انجام نشده و شرطی است، ردیف نقدی نمی‌سازد؛ حتی اگر کلاینت قدیمی ردیف فرستاده باشد.
  if (describesUnperformedCondition(payload.transcript)) throw invalidInput(UNPERFORMED_CONDITION_MESSAGE);
  if (priorSettlementDirection(payload.transcript)) throw invalidInput('این دریافت یا پرداخت مربوط به طلب یا بدهی قبلی است. ابتدا سند باز را در بخش تسویه انتخاب کن؛ درآمد یا هزینهٔ تازه ثبت نشد.');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Public transaction writes may describe review metadata, but cannot forge an
    // internal restore link, allocation status or bypass the accounting journal.
    // `factSource` فقط از پروندهٔ فهم رویداد روی سرور می‌آید؛ از بیرون پذیرفته
    // نمی‌شود، وگرنه یک درخواست می‌توانست کنترل‌های الگویی قضاوت را خاموش کند.
    // `fundedBy` هم فقط از سرور (تشخیص جمله یا پروندهٔ فهم) می‌آید، نه از بیرون.
    const transactions = (payload.transactions || []).map((item) => ({
      ...item, status: 'confirmed', restoredFrom: null, journalManaged: false, capitalFlow: '', factSource: undefined, fundedBy: undefined,
    }));
    const ids = insertTransactionRows({ ...payload, transactions, fromUtterance: true });
    db.exec('COMMIT');
    return ids;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/**
 * انتقال بین دو حساب خودِ شرکت، همراه کارمزد بانکی‌اش.
 *
 * «۴۰ میلیون از ملت به تجارت پایا زدیم و ۲۵ هزار کارمزدش از ملت کم شد» یک
 * انتقال است و یک هزینه. هر دو با هم ثبت می‌شوند یا هیچ‌کدام: انتقالِ بی‌کارمزد
 * ماندهٔ بانک مبدأ را ۲۵ هزار بیشتر از صورت‌حساب نشان می‌داد.
 */
export function transferWithFee({ fee = 0, ...values } = {}) {
  // کارمزد صفر یا خالی یعنی انتقال ساده؛ `cleanAmount(0)` خطا می‌دهد و هر
  // انتقال بی‌کارمزدِ برگهٔ انتقال را رد می‌کرد.
  if (fee === '' || fee === null || Number(fee) === 0) return transferBetweenAccounts(values);
  const charge = cleanAmount(fee);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = transferBetweenAccounts(values, { withinTransaction: true });
    if (charge >= result.amount) throw invalidInput('کارمزد نمی‌تواند از مبلغ انتقال بیشتر باشد.');
    const [feeTransactionId] = insertTransactionRows({ transcript: result.memo, transactions: [{
      amount: charge, type: 'expense', category: 'کارمزد بانکی', rawText: `کارمزد انتقال به ${result.to.name}`,
      source: 'text', accountId: result.from.id, occurredAt: result.occurredAt, status: 'confirmed',
      userConfirmed: true, needsReview: false, reviewReasons: [], restoredFrom: null, journalManaged: false, capitalFlow: '',
    }] });
    db.exec('COMMIT');
    return { ...result, fee: charge, feeTransactionId };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/**
 * هزینه یا خریدی که شریک یا کارمند از پول شخصی‌اش داد.
 *
 * همان رویداد و همان تصمیمی که ردیف نقدی می‌گرفت — هزینه، پیش‌پرداخت، موجودی یا
 * دارایی ثابت — فقط با منبع پولِ درست. ردیف `transactions` ساخته نمی‌شود چون
 * پولی از صندوق یا بانک شرکت نرفته؛ سند به خودِ رویداد لنگر می‌خورد.
 */
function recordFundedSpend(item, transcript, sentence, funder) {
  const amount = Math.round(Number(item.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw invalidInput('مبلغ معتبر نیست.');
  const occurredAt = item.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  const payerName = funder.name || (funder.kind === 'employee' ? `کارمند (${funder.role || 'بی‌نام'})` : funder.role || 'شریک');
  const payerId = funder.name ? contactIdForName(funder.name) : null;
  const draft = transactionEventDecision({ ...asFundedSpend(item, funder), amount, occurredAt, accountId: 'cash', rawText: item.rawText || transcript },
    { transcript, sentence, policy: automationPolicy(), counterpartyBalance: null });
  if (!draft) throw invalidInput('این هزینه از پول شخصی قابل ثبت نشد؛ گفته را به صف حسابدار بفرست.');
  const event = normalizeFinancialEvent({ ...draft.event, fundedBy: funder.kind, payerName, payerId });
  let result = recordFinancialEvent(db, event, {
    sourceEventId: `funded:${String(item.clientId || randomUUID()).slice(0, 100)}`,
    decision: draft.decision, actor: currentWorkspace()?.userId || null, transcript, rawInput: item.rawText || transcript,
    timeZone: currentTimeZone(), withinTransaction: true, accountingDecision: draft.accountingDecision || null,
  });
  if (item.userConfirmed === true && result.status === 'pending' && result.route === ROUTES.CONFIRM && !draft.decision.reasons.length
    && (!draft.accountingDecision || draft.accountingDecision.decisionStatus === 'decided')) {
    result = approveFinancialEvent(db, result.id, { actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(), withinTransaction: true });
  }
  audit('create', 'funded-spend', result.id, { amount, fundedBy: funder.kind, payerName, status: result.status });
  return result;
}
