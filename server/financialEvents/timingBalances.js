// ماندهٔ پیش‌پرداخت و درآمد انتقالیِ بی‌برنامه و ساختن برنامه برایش.
//
// از server/financialEventStore.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از
// پوشهٔ financialEvents همه از همان financialEventStore.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { ROUTES } from '../../shared/confidenceEngine.js';
import { readCoverageAnswers } from '../../shared/recognitionSchedule.js';
import { readServicePeriod } from '../../shared/periodSpeech.js';
import { scoreCategories } from '../../shared/categoryRules.js';
import { DECISION_STATUS } from '../../shared/accountingDecision.js';
import { storeError, ensureFinancialEventSchema, writeAudit, ledgerBalance } from './base.js';
import { storeDecision, storeSchedule, scheduleForEvent } from './schedule.js';
import { timingAccountKind } from './reviewTiming.js';
import { unitLabel } from '../../shared/amountUnit.js';

// ---------------------------------------------------------------------------
// ماندهٔ دفتر کلِ بی‌سند: پیش‌پرداخت یا درآمد انتقالی‌ای که برنامه ندارد
// ---------------------------------------------------------------------------

/** قلم‌های زنده‌ای که تخصیصشان از این حساب کم می‌کند. */
function scheduledOnAccount(database, accountId) {
  return Number(database.prepare(`SELECT COALESCE(SUM(i.amount),0) AS n FROM recognition_schedule_items i
    JOIN financial_events e ON e.id=i.event_id
    WHERE e.status='posted' AND i.status IN ('planned','blocked-closed-period')
      AND (i.account_id=? OR (i.account_id IS NULL AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id=e.journal_entry_id AND l.account_id=?)))`).get(accountId, accountId).n);
}

/** دورهٔ پیشنهادی از شرح سند — فقط پیشنهاد؛ حسابدار تأییدش می‌کند. */
function suggestedCoverage(text, occurredAt) {
  if (!text || !occurredAt) return null;
  const stated = readCoverageAnswers([{ text, side: 'any' }], { occurredAt });
  if (stated.start && stated.end) return stated;
  const spoken = readServicePeriod(text, { occurredAt });
  return spoken ? { start: spoken.start, end: spoken.end } : null;
}

/**
 * ماندهٔ پیش‌پرداخت یا درآمد انتقالی که هیچ برنامه‌ای پشتش نیست.
 *
 * تنها جایی که برنامه ساخته می‌شود رویداد است؛ ولی ماندهٔ افتتاحیه، سند دستی
 * دسته‌ای و سند اصلاحی مستقیم روی همین حساب‌ها می‌نشینند و هیچ‌وقت هزینه یا
 * درآمد نمی‌شوند — یک سال بعد همان مانده سر جایش است. این بررسیِ سطح دفتر کل
 * است، نه وصله روی هر مسیر ورود: برای هر حساب دوره‌دار، ماندهٔ واقعی منهای
 * جمع اقلام زندهٔ برنامه. اختلاف مثبت یعنی بخشی که کسی برایش دوره نگفته.
 *
 * خروجی هر حساب: مانده، جمع برنامه، اختلاف، و سندهایی که آن را ساخته‌اند — با
 * دورهٔ پیشنهادی از شرح سند، اگر شرح آن را صریح گفته باشد. چیزی ثبت نمی‌شود و
 * دوره‌ای حدس زده نمی‌شود.
 */
export function unscheduledTimingBalances(database, { accountId = null } = {}) {
  ensureFinancialEventSchema(database);
  const accounts = database.prepare(`SELECT a.id,a.name,a.source_kind AS sourceKind,a.source_key AS sourceKey,c.code AS chartCode
    FROM ledger_accounts a LEFT JOIN chart_accounts c ON c.id=a.chart_account_id
    WHERE (a.source_kind IN ('prepaid-asset','deferred-revenue') OR c.role IN ('prepaid-asset','deferred-revenue'))
      AND (? IS NULL OR a.id=?) ORDER BY a.code,a.id`).all(accountId, accountId);
  const result = [];
  for (const account of accounts) {
    const kind = timingAccountKind(database, account.id);
    if (!kind) continue;
    const balance = ledgerBalance(database, account.id);
    const held = kind === 'prepaid' ? balance : -balance;
    const scheduled = scheduledOnAccount(database, account.id);
    const residual = held - scheduled;
    const sign = kind === 'prepaid' ? 1 : -1;
    // ماندهٔ با علامت غلط — پیش‌پرداخت بستانکار، درآمد انتقالی بدهکار («طرف به ما
    // بدهکار است») — برنامه‌ای نمی‌خواهد؛ خطایی است که باید دیده و اصلاح شود، نه
    // اینکه چون «اختلاف مثبت نیست» بی‌صدا رد شود.
    if (held < 0) {
      const label = kind === 'prepaid' ? 'پیش‌پرداخت' : 'درآمد انتقالی';
      const side = kind === 'prepaid' ? 'بستانکار' : 'بدهکار';
      const entries = database.prepare(`SELECT j.id,j.source_type AS sourceType,j.occurred_at AS occurredAt,j.memo,j.document_number AS documentNumber,
          SUM(l.debit)-SUM(l.credit) AS net, group_concat(l.description,' ') AS descriptions
        FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
        WHERE l.account_id=? AND j.approval_state='approved' AND j.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)
        GROUP BY j.id HAVING net*?<0 ORDER BY j.occurred_at DESC,j.id DESC LIMIT 20`).all(account.id, sign)
        .map((entry) => ({
          entryId: entry.id, sourceType: entry.sourceType, occurredAt: entry.occurredAt, documentNumber: entry.documentNumber,
          memo: entry.memo, description: entry.descriptions || '', amount: Math.abs(entry.net), suggestedCoverage: null, suggestedCategory: null,
        }));
      result.push({
        accountId: account.id, accountName: account.name, chartCode: account.chartCode || null, kind,
        balance: held, scheduled, residual, entries, category: null, wrongSign: true,
        question: `ماندهٔ «${account.name}» ${(-held).toLocaleString('fa-IR')} ${unitLabel()} ${side} است؛ ${label} نباید ماندهٔ ${side} داشته باشد. استرداد، برگشت یا سند دستیِ بیرون از برنامه را بررسی و اصلاح کن.`,
      });
      continue;
    }
    if (residual <= 0) continue;
    const entries = database.prepare(`SELECT j.id,j.source_type AS sourceType,j.occurred_at AS occurredAt,j.memo,j.document_number AS documentNumber,
        SUM(l.debit)-SUM(l.credit) AS net, group_concat(l.description,' ') AS descriptions
      FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
      WHERE l.account_id=? AND j.approval_state='approved' AND j.source_type<>'recognition-schedule' AND j.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)
        AND j.id NOT IN (SELECT e.journal_entry_id FROM financial_events e WHERE e.journal_entry_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM recognition_schedule_items i WHERE i.event_id=e.id AND i.status<>'superseded'))
        AND j.id NOT IN (SELECT json_extract(e.payload,'$.anchorEntryId') FROM financial_events e WHERE e.kind='balance-recognition' AND e.status='posted'
          AND json_extract(e.payload,'$.accountId')=?)
      GROUP BY j.id HAVING net*?>0 ORDER BY j.occurred_at,j.id`).all(account.id, account.id, sign)
      .map((entry) => {
        const text = [entry.descriptions, entry.memo].filter(Boolean).join(' ');
        const coverage = suggestedCoverage(text, entry.occurredAt);
        const [guess] = scoreCategories(text, kind === 'prepaid' ? 'expense' : 'income');
        return {
          entryId: entry.id, sourceType: entry.sourceType, occurredAt: entry.occurredAt, documentNumber: entry.documentNumber,
          memo: entry.memo, description: entry.descriptions || '', amount: Math.abs(entry.net),
          suggestedCoverage: coverage, suggestedCategory: guess?.definition?.name || null,
        };
      });
    const linkedCategory = kind === 'prepaid' && account.sourceKind === 'prepaid-asset' && account.sourceKey && account.sourceKey !== 'عمومی' ? account.sourceKey : null;
    result.push({
      accountId: account.id, accountName: account.name, chartCode: account.chartCode || null, kind,
      balance: held, scheduled, residual, entries, category: linkedCategory,
      question: kind === 'deferred'
        ? `ماندهٔ ${residual.toLocaleString('fa-IR')} ${unitLabel()}ی «${account.name}» برنامهٔ شناسایی ندارد؛ دورهٔ خدمتی که پولش پیشاپیش گرفته شد از کی تا کی است و درآمد کدام دسته است؟`
        : `ماندهٔ ${residual.toLocaleString('fa-IR')} ${unitLabel()}ی «${account.name}» برنامهٔ هزینه‌شدن ندارد؛ دورهٔ پوشش از کی تا کی است${linkedCategory ? '' : ' و هزینهٔ کدام دسته است'}؟ اگر پیش‌پرداخت خرید کالاست، آن را به حساب پیش‌پرداخت خرید تأمین‌کننده منتقل کن.`,
    });
  }
  return result;
}

/**
 * جواب حسابدار به ماندهٔ بی‌برنامه: دوره و دسته — و برنامه از همان مانده.
 *
 * رویداد «شناسایی مانده» ثبت‌شده ساخته می‌شود که **هیچ سند تازه‌ای نمی‌زند**:
 * پول همان روزی جابه‌جا شده که سند مبنا (افتتاحیه، سند دستی، سند اصلاحی) آن را
 * نوشت. فقط برنامه دارد — به مبلغ همان مانده (یا بخشی از آن، وقتی یک حساب
 * کلی چند قرارداد را با هم نگه داشته)، روی همان حساب، و هیچ قلمی پیش از تاریخ
 * سند مبنا. ماه‌های گذشتهٔ پوشش در اجرای بعدی جبران می‌شوند.
 */
export function scheduleTimingBalance(database, accountId, {
  amount = null, start = null, end = null, coverageText = '', category = '', counterparty = '', counterpartyId = null,
  entryId = null, reason = '', actor = null, timeZone = 'Asia/Tehran',
} = {}) {
  ensureFinancialEventSchema(database);
  const listed = unscheduledTimingBalances(database, { accountId: String(accountId || '') });
  const open = listed.find((item) => !item.wrongSign);
  if (!open) {
    const wrong = listed.find((item) => item.wrongSign);
    throw storeError(wrong ? wrong.question : 'این حساب ماندهٔ بی‌برنامه‌ای ندارد.', wrong ? 'TIMING_BALANCE_WRONG_SIGN' : 'TIMING_BALANCE_NOT_OPEN', 409);
  }
  const value = amount == null ? open.residual : Number(amount);
  if (!Number.isSafeInteger(value) || value <= 0) throw storeError(`مبلغ برنامه باید عدد صحیح مثبت به ${unitLabel()} باشد.`, 'TIMING_BALANCE_INVALID', 400);
  if (value > open.residual) throw storeError(`مبلغ برنامه از ماندهٔ بی‌برنامه (${open.residual.toLocaleString('fa-IR')} ${unitLabel()}) بیشتر است.`, 'TIMING_BALANCE_INVALID', 400);
  const anchor = (entryId ? open.entries.find((entry) => entry.entryId === entryId) : open.entries.at(-1)) || null;
  if (entryId && !anchor) throw storeError('سند مبنای انتخاب‌شده این مانده را نساخته است.', 'TIMING_BALANCE_INVALID', 400);
  const occurredAt = anchor?.occurredAt || new Date().toISOString();
  const explicit = start && end ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() } : null;
  const coverage = explicit && !Number.isNaN(Date.parse(explicit.start)) && !Number.isNaN(Date.parse(explicit.end))
    ? explicit : readCoverageAnswers([{ text: coverageText, side: 'any' }], { occurredAt });
  if (!coverage.start || !coverage.end) {
    throw Object.assign(storeError(open.question, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id: 'coverage.start', text: open.question } });
  }
  const finalCategory = String(open.category || category || '').trim();
  if (!finalCategory) {
    const text = open.kind === 'deferred' ? 'درآمد این مانده کدام دسته است؟ (مثلاً «درآمد اجاره»)' : 'هزینهٔ این پیش‌پرداخت کدام دسته است؟ (مثلاً «بیمه»)';
    throw Object.assign(storeError(text, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id: 'balance.category', text } });
  }
  const explanation = String(reason || '').trim().slice(0, 500);
  const deferred = open.kind === 'deferred';
  const id = randomUUID();
  const event = {
    kind: 'balance-recognition', amount: value, occurredAt, category: finalCategory,
    counterparty: String(counterparty || '').trim() || null, counterpartyId: counterpartyId || null,
    servicePeriodStart: coverage.start, servicePeriodEnd: coverage.end,
    accountId: open.accountId, anchorEntryId: anchor?.entryId || null, anchorSourceType: anchor?.sourceType || null,
    evidence: [anchor?.description, anchor?.memo].filter(Boolean).join(' — ').slice(0, 500) || open.accountName,
  };
  const decision = {
    family: deferred ? 'advance-received' : 'asset-creation', treatment: deferred ? 'deferred-revenue' : 'prepaid-expense',
    recognitionDate: coverage.start, recognitionMethod: 'monthly-straight-line', riskLevel: 'yellow', decisionStatus: DECISION_STATUS.DECIDED,
    explanation: `ماندهٔ بی‌سند «${open.accountName}» با دورهٔ گفتهٔ حسابدار برنامه گرفت${explanation ? `: ${explanation}` : ''}.`,
    sourceReferences: [{ type: 'ledger-account', id: open.accountId }, ...(anchor ? [{ type: 'journal-entry', id: anchor.entryId }] : [])],
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO financial_events (id,source_event_id,kind,amount,occurred_at,payload,confidence,route,status,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, `balance-recognition:${open.accountId}:${id}`, event.kind, value, occurredAt,
      JSON.stringify(event), JSON.stringify({ route: ROUTES.ACCOUNTANT_REVIEW, reasons: [open.question] }), ROUTES.ACCOUNTANT_REVIEW, 'posted', actor);
    const decisionId = storeDecision(database, id, decision);
    database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, id);
    const stored = storeSchedule(database, id, decision, event, { amount: value, accountId: open.accountId, timeZone });
    writeAudit(database, id, 'balance-scheduled', {
      accountId: open.accountId, residualBefore: open.residual, amount: value, coverage, category: finalCategory,
      anchorEntryId: event.anchorEntryId, written: stored?.written || 0, blocked: stored?.blocked?.length || 0, reason: explanation,
    }, actor);
    database.exec('COMMIT');
    return { eventId: id, accountId: open.accountId, amount: value, coverage, items: scheduleForEvent(database, id) };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
