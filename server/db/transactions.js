import { randomUUID } from 'node:crypto';
import { accountForBank, resolveAccountId } from './accounts.js';
import { counterpartyLedgerBalance } from './counterpartyCard.js';
import { settlementDirection } from '../../shared/counterpartySettlement.js';
import { addLocalDays, audit, cleanAmount, currentTimeZone, currentWorkspace, dayBounds, db, invalidInput, localDay, parseStoredJson } from './core.js';
import { assertAccountingPeriodOpen, periodForDate, postCapitalJournal, reverseTransactionJournal, syncTransactionJournal } from '../accounting.js';
import { automationPolicy } from './settings.js';
import { extractContactName } from '../../shared/voiceIntent.js';
import { COMPOSITE_AMOUNT_MESSAGE, hasCompositeAmounts, normalizePersian } from '../../shared/parser.js';
import { priorSettlementDirection } from '../../shared/priorSettlement.js';
import { saveContact } from './contacts.js';
import { matchCounterparty } from '../counterparties.js';
import { recordFinancialEvent, recordShadowRun } from '../financialEventStore.js';
import { openDocumentsFor } from './counterpartyCard.js';
import { transactionEventDecision } from '../transactionEvent.js';
import { vatGuardContext } from '../tax.js';
import { NATURE_EXPLANATIONS, natureNeedsAccountant, readEventNature, readNonCashInstrument } from '../../shared/eventNature.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { decide } from '../../shared/accountingDecision.js';
import { factsFromEvent } from '../../shared/eventFacts.js';
import { ROUTES } from '../../shared/confidenceEngine.js';

export function getToday() {
  const today = localDay();
  const { start, endExclusive } = dayBounds(today);
  const transactions = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.journal_deferred AS journalDeferred,
    transactions.capital_flow AS capitalFlow,
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,transactions.account_id AS accountId,
    accounts.name AS accountName,transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.occurred_at>=? AND transactions.occurred_at<? AND transactions.status!='deleted' AND transactions.journal_deferred=0
    ORDER BY transactions.occurred_at DESC,transactions.created_at DESC`).all(start, endExclusive).map(hydrateTransaction);
  const totals = summarize(transactions);
  const previousBounds = dayBounds(addLocalDays(today, -1));
  const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income FROM transactions WHERE status!='deleted' AND journal_deferred=0 AND capital_flow='' AND occurred_at>=? AND occurred_at<?").get(previousBounds.start, previousBounds.endExclusive).income;
  totals.comparison = previous > 0 ? Math.round(((totals.income - previous) / previous) * 100) : null;
  return { transactions, summary: totals };
}

export function summarize(items) {
  // آوردهٔ سرمایه درآمد نیست و خرید دارایی ثابت هزینهٔ دوره نیست؛ هر دو از صندوق
  // رد می‌شوند و در ماندهٔ حساب و کنترل پایان روز دیده می‌شوند، ولی اگر در این
  // جمع بیایند سود دوره را جعل می‌کنند.
  const operational = items.filter((item) => !item.capitalFlow);
  const income = operational.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = operational.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount), 0);
  const netCashFlow = income - expense;
  // profit برای سازگاری نسخهٔ قبلی نگه داشته شده و نباید با سود حسابداری اشتباه شود.
  return { income, expense, netCashFlow, profit: netCashFlow, comparison: null };
}

export const CAPITAL_FLOWS = Object.freeze(['capital-in', 'fixed-asset']);

// دستهٔ این دو نوع ثبت، قرارداد بین ساخت و ویرایش است: از روی همین دسته
// می‌فهمیم سندش را چه کسی زده و عنوان دارایی چه بوده. اگر هر طرف رشتهٔ خودش
// را بنویسد، ویرایشِ یک دارایی ثابت حساب دوم می‌سازد.
export const CAPITAL_IN_CATEGORY = 'آورده و افزایش سرمایه';
export const FIXED_ASSET_CATEGORY_PREFIX = 'دارایی ثابت — ';

const capitalEntryTitle = (row) => (row.capitalFlow === 'fixed-asset'
  ? String(row.category || '').slice(FIXED_ASSET_CATEGORY_PREFIX.length) || 'دارایی ثابت'
  : 'آوردهٔ مالک');

function normalizeReviewState(value, fallback = 'ready') {
  return ['ready', 'review', 'unintelligible', 'reviewed', 'duplicate-confirmed'].includes(value) ? value : fallback;
}

export function jsonText(value, fallback) {
  try { return JSON.stringify(value ?? fallback); }
  catch { return JSON.stringify(fallback); }
}

/**
 * سندِ یک تراکنش، به همان شکل همیشگی‌اش.
 *
 * این تابع به لایهٔ رویداد تزریق می‌شود تا «چه وقت ثبت شود» را موتور اطمینان
 * تصمیم بگیرد ولی «سند چه شکلی باشد» همان‌جا بماند که هست و آزمون دارد.
 */
export function transactionJournalPoster(row, settlement = null) {
  return (database) => syncTransactionJournal(database, row, { createdBy: currentWorkspace()?.userId, settlement });
}

/**
 * آیا این جابه‌جایی پول، تسویهٔ حساب همان شخص است؟
 *
 * از ماندهٔ واقعی دفتر تصمیم گرفته می‌شود، نه از واژه‌های جمله: پول رفت و به
 * او بدهکار بودیم → بدهی‌اش کم می‌شود؛ پول آمد و او به ما بدهکار بود →
 * طلبمان کم می‌شود. هر حالت دیگری — از جمله پرداخت به کسی که حسابش صاف است —
 * همان ثبت عادیِ هزینه یا درآمد می‌ماند.
 */
export function settlementFor(row) {
  // «هیچ‌کدام» یعنی کاربر روی برگه دیده و گفته این ثبت هزینه یا درآمد عادی
  // است؛ حدس ما حق ندارد رویش بنویسد.
  if (row.settlement === 'none') return null;
  if (!row.contactId) return null;
  const contact = db.prepare('SELECT id,name FROM contacts WHERE id=?').get(row.contactId);
  if (!contact) return null;
  const balance = counterpartyLedgerBalance(contact);
  // جهت اعلام‌شدهٔ کاربر بر ماندهٔ دفتر مقدم است، ولی فقط وقتی با نوع ثبت
  // بخواند: «بابت بدهی او» فقط روی پرداخت معنا دارد و «بابت طلب او» فقط
  // روی دریافت.
  const askedFits = (row.settlement === 'payable' && row.type === 'expense')
    || (row.settlement === 'receivable' && row.type === 'income');
  const direction = askedFits ? row.settlement : settlementDirection(row.type, balance);
  if (!direction) return null;
  return { direction, contactId: contact.id, contactName: contact.name, balance };
}

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
    const result = recordFinancialEvent(db, draft.event, {
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
 * طرف حسابی که در خود جمله گفته شده، به ثبت وصل می‌شود.
 *
 * «۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد» یک هزینهٔ ساده ثبت
 * می‌شد و هیچ‌وقت به کارت آن شرکت نمی‌رسید — با اینکه نامش صریح در جمله بود.
 * و چون سند به حساب طرف حساب نمی‌خورد، فهرست طرف حساب‌ها یک عدد نشان می‌داد
 * و کارتش عدد دیگری.
 *
 * `extractContactName` فقط با عنوان صریح کار می‌کند — «شرکت»، «آقای»،
 * «خانم» و مانندشان — پس «به پیک پول دادم» طرف حساب نمی‌سازد و فهرست از
 * نام‌های بی‌ربط پر نمی‌شود.
 *
 * `saveContact` خودش هر سه حالت را می‌داند: تطابق دقیق وصل می‌شود، نام مشابه
 * پرسیده می‌شود (`COUNTERPARTY_SIMILAR` که رابط به برگهٔ تأیید تبدیلش
 * می‌کند) و نام تازه ساخته می‌شود. هیچ‌کدام اینجا دوباره پیاده نشده.
 */
function counterpartyFromSentence(item, transcript, counterpartyResolution) {
  // نامی که پارسر از **کل جمله** برداشته، بر متن ردیف مقدم است.
  //
  // `rawText` فقط تکهٔ کنار مبلغ است: در «از شرکت پخش البرز پانزده میلیون
  // تومان دریافت شد» به «تومان دریافت شد» کوتاه می‌شود و نام شرکت — که در
  // نیمهٔ اول جمله بود — کاملاً گم می‌شد.
  const name = String(item.contactName || '').trim()
    || extractContactName(String(item.rawText || transcript || ''));
  if (!name) return null;
  // نامِ حدسی (بدون عنوان) فقط وقتی وصل می‌شود که با طرف حسابی که از قبل در
  // دفتر هست بخواند. «به پیک پول دادم» نباید کارت حساب «پیک پول» بسازد —
  // ساختنش تصمیم کاربر است و برگهٔ تأیید آن را می‌پرسد.
  if (item.contactNameConfident === false && item.linkContact !== true) {
    return matchCounterparty(db, name).exact?.id || null;
  }
  return saveContact({ name, counterpartyResolution }).id;
}

/**
 * جمله‌ای که اصلاح یک ثبت قبلی است، تراکنش تازه نیست.
 *
 * «فاکتور خرید دیروز اشتباهاً بیست و یک میلیون ثبت شده بود، اصلاحش کن» روی
 * برگهٔ تأیید دو ردیف نقدی تازه می‌ساخت — دوازده و بیست و یک میلیون — و ماندهٔ
 * صندوق سی و سه میلیون کم می‌شد، درحالی‌که هیچ پولی جابه‌جا نشده بود. اصلاح،
 * سند اصلاحی با ارجاع به سند اول می‌خواهد و آن کار حسابدار است.
 *
 * فقط برای گفتهٔ کاربر (صدا یا متن). مسیرهای داخلی — تسویه، رسید، تکرار —
 * متن خودشان را می‌سازند و این واژه‌ها در آن‌ها معنای دیگری ندارند.
 */
function correctionNature(item, transcript) {
  if (item.journalManaged || item.restoredFrom || !['voice', 'text', undefined].includes(item.source)) return null;
  const nature = item.eventNature || readEventNature(String(item.rawText || '')) || null;
  const fromSentence = readEventNature(String(transcript || ''));
  const chosen = natureNeedsAccountant(nature) ? nature : fromSentence;
  return natureNeedsAccountant(chosen) ? chosen : null;
}

const NON_CASH_REASON = 'این جمله از چک یا سفته‌ای می‌گوید که هنوز وصول نشده؛ چک تا وصول نشود پول نیست و ردیف نقدی ساخته نشد.';

/** چکی که پول نیست — همان مسیر اصلاح: بدون ردیف نقدی، مستقیم به حسابدار. */
function nonCashInstrument(item, transcript) {
  if (item.journalManaged || item.restoredFrom || !['voice', 'text', undefined].includes(item.source)) return false;
  return readNonCashInstrument(transcript || item.rawText || '');
}

function queueCorrectionForAccountant(item, transcript, nature) {
  const amount = Math.round(Number(item.amount));
  const event = normalizeFinancialEvent({
    kind: item.type === 'income' ? EVENT_KINDS.CASH_INCOME : EVENT_KINDS.CASH_EXPENSE,
    amount, occurredAt: item.occurredAt || new Date().toISOString(),
    category: item.category, description: item.category, accountId: resolveAccountId(item),
    source: item.source === 'voice' ? 'voice' : 'text', eventNature: nature === 'non-cash-instrument' ? 'new' : nature,
    evidence: String(transcript || item.rawText || '').slice(0, 1000),
  });
  const accountingDecision = decide(factsFromEvent(event), { today: event.occurredAt });
  const reason = nature === 'non-cash-instrument' ? NON_CASH_REASON
    : NATURE_EXPLANATIONS[nature] || 'این جمله اصلاح یک ثبت قبلی است، نه تراکنش تازه.';
  return recordFinancialEvent(db, event, {
    sourceEventId: `correction:${item.clientId || randomUUID()}`,
    decision: { route: ROUTES.ACCOUNTANT_REVIEW, reasons: [reason], summary: reason },
    actor: currentWorkspace()?.userId || null, transcript, rawInput: transcript,
    timeZone: currentTimeZone(), withinTransaction: true, accountingDecision,
  });
}

// `fromUtterance` فقط از مسیر عمومی ثبت (گفته یا متن کاربر) روشن است. مسیرهای
// داخلی — رسید، صورت‌حساب بانک، تسویهٔ تعهد، فاکتور، تکرار — متن خودشان را
// می‌سازند («واریز چک»، «شماره چک» در رسید) و شناسهٔ ردیف ساخته‌شده را لازم
// دارند؛ صف کردنشان بدون ردیف آن مسیرها را می‌شکست.
export function insertTransactionRows({ transcript, transactions, counterpartyResolution = '', fromUtterance = false }) {
  const insert = db.prepare(`INSERT OR IGNORE INTO transactions
    (id,client_id,amount,type,category,raw_text,source,confidence,needs_review,confidence_details,review_reasons,review_state,restored_from,capital_flow,occurred_at,contact_id,account,account_id,note,status,due_at,updated_at,settlement_choice)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  let queuedForAccountant = 0;
  const queuedReasons = [];
  for (const item of transactions) {
    const nature = fromUtterance
      ? correctionNature(item, transcript) || (nonCashInstrument(item, transcript) ? 'non-cash-instrument' : null)
      : null;
    if (nature) {
      const amount = Math.round(Number(item.amount));
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw invalidInput('مبلغ معتبر نیست.');
      queueCorrectionForAccountant(item, transcript, nature);
      queuedForAccountant += 1;
      queuedReasons.push(nature === 'non-cash-instrument' ? NON_CASH_REASON : (NATURE_EXPLANATIONS[nature] || ''));
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
    );
    if (result.changes) {
      ids.push(id);
      audit('create', 'transaction', id, { amount, type: item.type, category: item.category });
      if (!item.journalManaged) {
        // شناسهٔ طرف حساب هم می‌رود: بدون آن، سند هرگز نمی‌فهمد این پرداخت
        // تسویهٔ بدهی همان شخص است و همیشه روی دستهٔ هزینه می‌نشیند.
        const row = { id, amount, type: item.type, category: item.category, rawText: item.rawText || transcript, accountId, occurredAt, contactId: contactId || null, settlement: item.settlement || null };
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
  return Object.assign(ids, { queuedForAccountant, queuedReasons });
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
  if (priorSettlementDirection(payload.transcript)) throw invalidInput('این دریافت یا پرداخت مربوط به طلب یا بدهی قبلی است. ابتدا سند باز را در بخش تسویه انتخاب کن؛ درآمد یا هزینهٔ تازه ثبت نشد.');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Public transaction writes may describe review metadata, but cannot forge an
    // internal restore link, allocation status or bypass the accounting journal.
    const transactions = (payload.transactions || []).map((item) => ({
      ...item, status: 'confirmed', restoredFrom: null, journalManaged: false, capitalFlow: '',
    }));
    const ids = insertTransactionRows({ ...payload, transactions, fromUtterance: true });
    db.exec('COMMIT');
    return ids;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function similarityTerms(value) {
  return new Set(normalizePersian(value).toLowerCase().replace(/[^0-9آ-ی\s]/g, ' ').split(/\s+/).filter((term) => term.length > 1));
}

function textSimilarity(left, right) {
  const leftTerms = similarityTerms(left);
  const rightTerms = similarityTerms(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  return overlap / (leftTerms.size + rightTerms.size - overlap);
}

export function findPotentialDuplicates(transactions = [], { windowMinutes = 5 } = {}) {
  const duplicates = [];
  for (const [inputIndex, item] of transactions.entries()) {
    if (item.clientId && db.prepare('SELECT 1 FROM transactions WHERE client_id=?').get(item.clientId)) continue;
    const amount = Math.round(Number(item.amount));
    if (!Number.isSafeInteger(amount) || !['income', 'expense'].includes(item.type)) continue;
    const occurredAt = item.occurredAt || new Date().toISOString();
    const accountId = resolveAccountId(item);
    const incomingText = String(item.rawText || '');
    const candidates = db.prepare(`SELECT id,amount,type,category,raw_text AS rawText,occurred_at AS occurredAt,
      account_id AS accountId FROM transactions
      WHERE status!='deleted' AND amount=? AND type=? AND account_id=?
        AND ABS((julianday(occurred_at)-julianday(?))*1440)<=?
      ORDER BY occurred_at DESC LIMIT 8`).all(amount, item.type, accountId, occurredAt, Math.max(1, Number(windowMinutes) || 5));
    for (const candidate of candidates) {
      const similarity = textSimilarity(`${incomingText} ${item.category || ''}`, `${candidate.rawText} ${candidate.category || ''}`);
      if (similarity < 0.42) continue;
      duplicates.push({ inputIndex, ...candidate, similarity: Math.round(similarity * 100) });
      break;
    }
  }
  return duplicates;
}

export function typicalAmounts() {
  const rows = db.prepare("SELECT type, AVG(amount) AS average FROM (SELECT type,amount FROM transactions WHERE status!='deleted' AND capital_flow='' ORDER BY occurred_at DESC LIMIT 120) GROUP BY type").all();
  return Object.fromEntries(rows.map((row) => [row.type, Math.round(row.average)]));
}

export function report(range = 'month', now = new Date()) {
  const days = range === 'week' ? 7 : range === 'quarter' ? 90 : 30;
  const timeZone = currentTimeZone();
  const today = localDay(now, timeZone);
  const startDay = addLocalDays(today, -(days - 1));
  const start = dayBounds(startDay, timeZone).start;
  const endExclusive = dayBounds(addLocalDays(today, 1), timeZone).start;
  const items = db.prepare("SELECT amount,type,category,capital_flow AS capitalFlow,occurred_at AS occurredAt FROM transactions WHERE status!='deleted' AND journal_deferred=0 AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at").all(start, endExclusive);
  const summary = summarize(items);
  const bucketCount = range === 'quarter' ? 12 : range === 'month' ? 10 : 7;
  const bucketDays = Math.ceil(days / bucketCount);
  const points = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const fromDay = addLocalDays(startDay, index * bucketDays);
    const untilDay = addLocalDays(startDay, Math.min(days, (index + 1) * bucketDays));
    const from = new Date(dayBounds(fromDay, timeZone).start);
    const until = new Date(dayBounds(untilDay, timeZone).start);
    const group = items.filter((item) => { const time = new Date(item.occurredAt); return time >= from && time < until; });
    const totals = summarize(group);
    points.push({ label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone, day: 'numeric', month: range === 'quarter' ? 'short' : undefined }).format(from), income: totals.income, expense: totals.expense });
  }
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.type}:${item.category}`;
    grouped.set(key, { name: item.category, type: item.type, amount: (grouped.get(key)?.amount || 0) + Number(item.amount) });
  }
  const totalsByType = { income: Math.max(1, summary.income), expense: Math.max(1, summary.expense) };
  const categories = [...grouped.values()].sort((a, b) => b.amount - a.amount)
    .map((item) => ({ ...item, share: Math.round(item.amount / totalsByType[item.type] * 100) }));
  const biggestExpense = categories.find((item) => item.type === 'expense');
  const insight = biggestExpense ? `بیشترین هزینهٔ این بازه مربوط به «${biggestExpense.name}» و مبلغ آن ${new Intl.NumberFormat('fa-IR').format(biggestExpense.amount)} تومان بوده است.` : '';
  return { basis: 'cash', basisLabel: 'مبنای دریافت و پرداخت', summary, points, categories, insight };
}

function hydrateTransaction(item) {
  if (!item) return null;
  return {
    ...item,
    needsReview: Boolean(item.needsReview),
    confidenceDetails: parseStoredJson(item.confidenceDetails, {}),
    reviewReasons: parseStoredJson(item.reviewReasons, []),
  };
}

function transactionQuery(includeDeleted = false) {
  return `SELECT transactions.id,transactions.client_id AS clientId,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.journal_deferred AS journalDeferred,
    transactions.occurred_at AS occurredAt,transactions.created_at AS createdAt,transactions.note,transactions.account,transactions.status,
    transactions.capital_flow AS capitalFlow,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName,transactions.due_at AS dueAt
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.id=?${includeDeleted ? '' : " AND transactions.status!='deleted'"}`;
}

export function transactionRow(id) {
  return hydrateTransaction(db.prepare(transactionQuery(false)).get(id));
}

function transactionAnyRow(id) {
  return hydrateTransaction(db.prepare(transactionQuery(true)).get(id));
}

export function getTransaction(id) {
  return transactionRow(id);
}

export function latestTransaction() {
  const row = db.prepare(`SELECT id FROM transactions WHERE status!='deleted' ORDER BY created_at DESC,rowid DESC LIMIT 1`).get();
  return row ? transactionRow(row.id) : null;
}

export function listTransactions({ query = '', type = '', category = '', from = '', to = '', page = 1, limit = 30 } = {}) {
  const clauses = ["transactions.status!='deleted'"];
  const values = [];
  if (query) {
    clauses.push('(transactions.raw_text LIKE ? OR transactions.note LIKE ? OR transactions.category LIKE ? OR contacts.name LIKE ?)');
    const pattern = `%${String(query).slice(0, 100)}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (['income', 'expense'].includes(type)) { clauses.push('transactions.type=?'); values.push(type); }
  if (category) { clauses.push('transactions.category=?'); values.push(String(category).slice(0, 80)); }
  if (from) { clauses.push('transactions.occurred_at>=?'); values.push(String(from)); }
  if (to) { clauses.push('transactions.occurred_at<=?'); values.push(String(to)); }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const safePage = Math.max(1, Number(page) || 1);
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id WHERE ${where}`).get(...values).count;
  const items = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.journal_deferred AS journalDeferred,
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,transactions.status,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE ${where} ORDER BY transactions.occurred_at DESC LIMIT ? OFFSET ?`)
    .all(...values, safeLimit, (safePage - 1) * safeLimit).map(hydrateTransaction);
  return { items, total, page: safePage, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}

export function updateTransaction(id, values = {}) {
  const current = transactionRow(id);
  if (!current) return null;
  if (current.journalDeferred) throw Object.assign(new Error('این ثبت هنوز در صف بررسی است؛ ابتدا آن را از همان صف تعیین‌تکلیف کن.'), { code: 'PENDING_TRANSACTION_LOCKED', status: 409 });
  if (current.status === 'allocated') throw Object.assign(new Error('این جابه‌جایی پول از تسویهٔ یک سند ساخته شده و فقط از داخل همان سند قابل اصلاح است.'), { code: 'ALLOCATED_TRANSACTION_LOCKED', status: 409 });
  const type = ['income', 'expense'].includes(values.type) ? values.type : current.type;
  const amount = values.amount == null ? current.amount : cleanAmount(values.amount);
  const occurredAt = values.occurredAt || current.occurredAt;
  const accountId = values.accountId == null && values.account == null ? current.accountId : resolveAccountId(values);
  assertAccountingPeriodOpen(db, periodForDate(current.occurredAt, currentTimeZone()));
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  const category = String(values.category || current.category).slice(0, 80);
  const rawText = String(values.rawText ?? current.rawText).slice(0, 1000);
  // ثبت سرمایه‌ای نوعش را از جریانش می‌گیرد، نه از فرم: «آورده» همیشه
  // بستانکار سرمایه است و «دارایی ثابت» همیشه بدهکار دارایی.
  if (current.capitalFlow && values.type && values.type !== current.type) {
    throw Object.assign(new Error('نوع ثبت آورده یا دارایی ثابت عوض نمی‌شود؛ اگر اشتباه ثبت شده، حذفش کن و درست ثبت کن.'), { code: 'CAPITAL_TYPE_LOCKED', status: 409 });
  }
  const changedByUser = ['amount', 'type', 'category', 'accountId', 'account'].some((field) => values[field] !== undefined);
  const needsReview = values.needsReview === undefined ? (changedByUser ? false : current.needsReview) : Boolean(values.needsReview);
  const confidence = Number(values.confidence ?? current.confidence ?? 1);
  const confidenceDetails = values.confidenceDetails ?? current.confidenceDetails ?? {};
  const reviewReasons = values.reviewReasons ?? current.reviewReasons ?? [];
  const reviewState = normalizeReviewState(values.reviewState, changedByUser ? 'reviewed' : current.reviewState);
  db.exec('BEGIN IMMEDIATE');
  try {
    reverseTransactionJournal(db, id, current.occurredAt, { createdBy: currentWorkspace()?.userId });
    db.prepare(`UPDATE transactions SET amount=?,type=?,category=?,raw_text=?,note=?,account=?,account_id=?,contact_id=?,occurred_at=?,due_at=?,
      confidence=?,needs_review=?,confidence_details=?,review_reasons=?,review_state=?,updated_at=? WHERE id=?`)
      .run(amount, type, category, rawText, String(values.note ?? current.note ?? '').slice(0, 500), accountId, accountId,
        values.contactId === undefined ? current.contactId : (values.contactId || null), occurredAt,
        values.dueAt === undefined ? current.dueAt : (values.dueAt || null), confidence, needsReview ? 1 : 0,
        jsonText(confidenceDetails, {}), jsonText(reviewReasons, []), reviewState, new Date().toISOString(), id);
    // سند این ثبت از کدام مسیر آمده بود؟ آورده و دارایی ثابت از
    // `postCapitalJournal` می‌آیند و اگر ویرایش، سند تازه را از مسیر دستهٔ
    // درآمد/هزینه بسازد، آورده تبدیل به درآمد می‌شود و دارایی ثابت به هزینه —
    // دقیقاً همان چیزی که کل طراحی «جریان سرمایه» برای جلوگیری از آن ساخته
    // شده بود. جمع سند هم درست می‌ماند، پس هیچ کنترلی نمی‌گیردش.
    if (current.capitalFlow) {
      postCapitalJournal(db, {
        transactionId: id, kind: current.capitalFlow, amount, accountId, occurredAt,
        title: capitalEntryTitle({ ...current, category }),
      }, { createdBy: currentWorkspace()?.userId });
    } else {
      syncTransactionJournal(db, { id, amount, type, category, rawText, accountId, occurredAt }, { createdBy: currentWorkspace()?.userId });
    }
    audit('update', 'transaction', id, { before: current, after: values });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return transactionRow(id);
}

export function correctLatestTransaction(targetId, command, changes = {}) {
  const latest = latestTransaction();
  if (!latest) throw Object.assign(new Error('هنوز ثبتی برای اصلاح وجود ندارد.'), { code: 'LATEST_TRANSACTION_MISSING', status: 404 });
  if (!targetId || latest.id !== targetId) throw Object.assign(new Error('در این فاصله ثبت تازه‌ای اضافه شده؛ اصلاح را دوباره بررسی کن.'), { code: 'LATEST_TRANSACTION_CHANGED', status: 409 });
  const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => ['amount', 'type', 'category', 'accountId'].includes(key)));
  if (!Object.keys(allowed).length) throw Object.assign(new Error('تغییر قابل‌اعمالی در فرمان پیدا نشد.'), { code: 'CORRECTION_EMPTY', status: 400 });
  const item = updateTransaction(targetId, {
    ...allowed,
    rawText: `${latest.rawText}\nاصلاح گفتاری: ${String(command || '').trim()}`,
    needsReview: false,
    reviewState: 'reviewed',
    reviewReasons: [...(latest.reviewReasons || []), `اصلاح با فرمان کاربر: ${String(command || '').trim()}`],
  });
  audit('conversation_correction', 'transaction', targetId, { command: String(command || '').slice(0, 500), changes: allowed });
  return item;
}

export function deleteTransaction(id) {
  const current = transactionRow(id);
  if (!current) return false;
  if (current.journalDeferred) throw Object.assign(new Error('برای حذف ثبت معلق، آن را در صف بررسی رد کن تا رویداد و تراکنش با هم بسته شوند.'), { code: 'PENDING_TRANSACTION_LOCKED', status: 409 });
  if (current.status === 'allocated') throw Object.assign(new Error('تراکنش تخصیص‌یافته به سند را نمی‌توان جداگانه حذف کرد.'), { code: 'ALLOCATED_TRANSACTION_LOCKED', status: 409 });
  assertAccountingPeriodOpen(db, periodForDate(current.occurredAt, currentTimeZone()));
  db.exec('BEGIN IMMEDIATE');
  try {
    reverseTransactionJournal(db, id, current.occurredAt, { createdBy: currentWorkspace()?.userId, memo: 'سند معکوس حذف تراکنش' });
    db.prepare("UPDATE transactions SET status='deleted',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    audit('delete', 'transaction', id, current);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}

export function redoTransaction(id) {
  const current = transactionAnyRow(id);
  if (!current || current.status !== 'deleted') throw Object.assign(new Error('ثبت حذف‌شده برای بازیابی پیدا نشد.'), { code: 'REDO_SOURCE_MISSING', status: 404 });
  const alreadyRestored = db.prepare("SELECT id FROM transactions WHERE restored_from=? AND status!='deleted' ORDER BY created_at DESC LIMIT 1").get(id);
  if (alreadyRestored) throw Object.assign(new Error('این ثبت قبلاً بازیابی شده است.'), { code: 'TRANSACTION_ALREADY_RESTORED', status: 409, details: { id: alreadyRestored.id } });
  db.exec('BEGIN IMMEDIATE');
  try {
    const [restoredId] = insertTransactionRows({ transcript: current.rawText, transactions: [{
      amount: current.amount, type: current.type, category: current.category, rawText: current.rawText,
      source: current.source, confidence: current.confidence, confidenceDetails: current.confidenceDetails,
      reviewReasons: [...(current.reviewReasons || []), 'ثبت حذف‌شده با درخواست کاربر دوباره ایجاد شد.'],
      reviewState: 'reviewed', needsReview: false, accountId: current.accountId, contactId: current.contactId,
      note: current.note, dueAt: current.dueAt, occurredAt: current.occurredAt, restoredFrom: id,
    }] });
    audit('redo', 'transaction', restoredId, { restoredFrom: id });
    db.exec('COMMIT');
    return transactionRow(restoredId);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
