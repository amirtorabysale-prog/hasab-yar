import { randomUUID } from 'node:crypto';
import { FINANCIAL_DISCLAIMER, FINANCIAL_UNIT, buildRunway, detectExpenseGrowth, exactWindow, financialScope, findUnusualTransaction, invoiceSource, isGuardedAdviceQuestion, obligationSource, prioritizeAlerts, transactionSource } from '../financialIntelligence.js';
import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace, db, getSettings, invalidInput } from './core.js';
import { dnaCategoryProfiles, financialDna, overdueBackboneCategories } from '../financialDna.js';
import { getCategories, listAccounts } from './accounts.js';
import { listContacts } from './contacts.js';
import { listInvoices } from './invoices.js';
import { listObligations } from './obligations.js';
import { normalizePersian } from '../../shared/parser.js';
import { periodForDate } from '../accounting.js';
import { summarize } from './transactions.js';

function financialTransactionRows(window, filters = {}) {
  const clauses = ["transactions.status!='deleted'", 'transactions.occurred_at>=?', 'transactions.occurred_at<?'];
  const values = [window.from, window.to];
  if (filters.type) { clauses.push('transactions.type=?'); values.push(filters.type); }
  if (filters.category) { clauses.push('transactions.category=?'); values.push(filters.category); }
  if (filters.contactId) { clauses.push('transactions.contact_id=?'); values.push(filters.contactId); }
  return db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.capital_flow AS capitalFlow,
    transactions.raw_text AS rawText,transactions.occurred_at AS occurredAt,transactions.account_id AS accountId,
    accounts.name AS accountName,transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
    LEFT JOIN contacts ON contacts.id=transactions.contact_id
    WHERE ${clauses.join(' AND ')} ORDER BY transactions.occurred_at DESC`).all(...values);
}

function accountSources(accounts) {
  return accounts.filter((item) => item.active && ['cash', 'bank', 'wallet'].includes(item.kind)).map((item) => ({
    kind: 'account', id: item.id, label: item.name, amount: Number(item.balance || 0), openingBalance: Number(item.openingBalance || 0), createdAt: item.createdAt || null,
  }));
}

function money(value) {
  return new Intl.NumberFormat('fa-IR').format(Math.round(Number(value) || 0));
}

function sourceScope(sources, now, label = 'از اولین سند باز تا اکنون') {
  const dated = sources.map((item) => item.occurredAt || item.dueAt || item.createdAt).filter(Boolean).sort();
  return { from: dated[0] || null, to: now.toISOString(), days: null, label, basis: 'cash', basisLabel: 'مبنای دریافت و پرداخت', unit: FINANCIAL_UNIT };
}

function financialAnswer({ question, intent, answer, result = null, scope = null, sources = [], calculation = '', now = new Date(), disclaimer = FINANCIAL_DISCLAIMER }) {
  return {
    question, intent, answer, result, scope, sources, evidence: sources,
    provenance: { sourceCount: sources.length, calculation, complete: true },
    unit: result ? FINANCIAL_UNIT : null,
    disclaimer, generatedAt: now.toISOString(), deterministic: true,
  };
}

function snoozedFinancialAlertIds(now = new Date()) {
  const userId = currentWorkspace()?.userId || null;
  const rows = userId
    ? db.prepare("SELECT DISTINCT alert_id AS alertId FROM financial_alert_feedback WHERE action='snooze' AND snoozed_until>? AND created_by=?").all(now.toISOString(), userId)
    : db.prepare("SELECT DISTINCT alert_id AS alertId FROM financial_alert_feedback WHERE action='snooze' AND snoozed_until>? AND created_by IS NULL").all(now.toISOString());
  return new Set(rows.map((item) => item.alertId));
}

export function snoozeFinancialAlert(alertId, { hours = 24 } = {}) {
  const normalizedId = String(alertId || '').trim().slice(0, 120);
  if (!/^[a-z0-9-]+$/i.test(normalizedId)) throw invalidInput('شناسهٔ هشدار معتبر نیست.');
  const safeHours = Math.min(168, Math.max(1, Math.round(Number(hours) || 24)));
  const snoozedUntil = new Date(Date.now() + safeHours * 60 * 60 * 1000).toISOString();
  const id = randomUUID();
  db.prepare("INSERT INTO financial_alert_feedback (id,alert_id,action,snoozed_until,created_by) VALUES (?,?, 'snooze',?,?)")
    .run(id, normalizedId, snoozedUntil, currentWorkspace()?.userId || null);
  audit('snooze', 'financial_alert', normalizedId, { hours: safeHours, snoozedUntil });
  return { id, alertId: normalizedId, action: 'snooze', snoozedUntil };
}

/**
 * DNA مالی پرونده. پنجرهٔ پیش‌فرض شش ماه است تا الگوی فصلی جا بیفتد، ولی
 * محاسبه هیچ ادعایی بدون دادهٔ کافی نمی‌کند.
 */
export function financialDnaOverview({ months = 6, now = new Date() } = {}) {
  const from = new Date(now.getTime() - Math.max(1, Math.min(24, Number(months) || 6)) * 30 * 24 * 60 * 60 * 1000);
  const rows = activeWorkspaceDatabase().prepare(`SELECT amount,type,category,source,
    occurred_at AS occurredAt,created_at AS createdAt
    FROM transactions WHERE status='confirmed' AND capital_flow='' AND occurred_at>=? ORDER BY occurred_at`).all(from.toISOString());
  // فشار پرداخت تنها صفتی است که به آینده نگاه می‌کند و ورودی‌اش تعهدهای باز
  // است، نه تراکنش‌های گذشته.
  return financialDna(rows, { timeZone: currentTimeZone(), now, months, obligations: listObligations({ status: 'open' }) });
}

/**
 * پروفایل دسته‌ها برای تصمیم‌گیری پیش از ثبت.
 * پنجرهٔ شش ماه با خود DNA یکی است تا کاربر همان چیزی را ببیند که تصمیم بر پایه‌اش
 * گرفته شده.
 */
export function dnaProfiles({ months = 6, now = new Date() } = {}) {
  const from = new Date(now.getTime() - Math.max(1, Math.min(24, Number(months) || 6)) * 30 * 24 * 60 * 60 * 1000);
  const rows = activeWorkspaceDatabase().prepare(`SELECT amount,type,category,source,
    occurred_at AS occurredAt,created_at AS createdAt
    FROM transactions WHERE status='confirmed' AND capital_flow='' AND occurred_at>=? ORDER BY occurred_at`).all(from.toISOString());
  return dnaCategoryProfiles(rows, { timeZone: currentTimeZone() });
}

export function financialOverview(now = new Date()) {
  const settings = getSettings();
  const accounts = listAccounts();
  const liquidAccounts = accounts.filter((item) => item.active && ['cash', 'bank', 'wallet'].includes(item.kind));
  const cash = liquidAccounts.reduce((sum, item) => sum + Number(item.balance || 0), 0);
  const monthWindow = exactWindow(now, 30);
  const monthScope = financialScope(monthWindow, '۳۰ روز اخیر');
  const monthRows = financialTransactionRows(monthWindow);
  const month = summarize(monthRows);
  const expenseRows = monthRows.filter((item) => item.type === 'expense');
  const invoices = listInvoices().items;
  const openInvoices = invoices.filter((item) => !['draft', 'cancelled', 'paid'].includes(item.displayStatus) && Number(item.balanceDue) > 0);
  const openObligations = listObligations({ status: 'open' });
  const receivable = openObligations.filter((item) => item.direction === 'receivable').reduce((sum, item) => sum + Number(item.amount), 0)
    + openInvoices.filter((item) => item.documentType === 'sales').reduce((sum, item) => sum + Number(item.balanceDue), 0);
  const payable = openObligations.filter((item) => item.direction === 'payable').reduce((sum, item) => sum + Number(item.amount), 0)
    + openInvoices.filter((item) => item.documentType === 'purchase').reduce((sum, item) => sum + Number(item.balanceDue), 0);
  const overdueObligations = openObligations.filter((item) => item.dueAt && new Date(item.dueAt) < now);
  const overdueInvoices = openInvoices.filter((item) => item.dueAt && new Date(item.dueAt) < now);
  const overdueItems = [...overdueObligations.map(obligationSource), ...overdueInvoices.map(invoiceSource)];
  const overdueReceivables = overdueItems.filter((item) => item.direction === 'receivable');
  const runway = buildRunway({ cash, expenseTotal: month.expense, lookbackDays: 30, scope: monthScope, sources: expenseRows.map(transactionSource) });
  const alerts = [];

  if (overdueReceivables.length) {
    const total = overdueReceivables.reduce((sum, item) => sum + item.amount, 0);
    alerts.push({
      id: 'overdue-receivable', type: 'overdue-receivable', level: 'danger', priority: 100,
      title: `${overdueReceivables.length} طلب سررسیدشده داری`, detail: `${money(total)} تومان وصول عقب‌افتاده است.`,
      value: total, unit: FINANCIAL_UNIT, scope: sourceScope(overdueReceivables, now), sources: overdueReceivables,
      action: { screen: 'ledger', tab: 'obligations', label: 'پیگیری طلب‌ها' },
    });
  } else if (overdueItems.length) {
    const total = overdueItems.reduce((sum, item) => sum + item.amount, 0);
    alerts.push({
      id: 'overdue-payable', type: 'overdue-payable', level: 'danger', priority: 95,
      title: `${overdueItems.length} بدهی سررسیدشده داری`, detail: `${money(total)} تومان پرداخت عقب‌افتاده است.`,
      value: total, unit: FINANCIAL_UNIT, scope: sourceScope(overdueItems, now), sources: overdueItems,
      action: { screen: 'ledger', tab: 'obligations', label: 'بررسی بدهی‌ها' },
    });
  }

  const historyWindow = exactWindow(now, 90);
  const historyRows = financialTransactionRows(historyWindow);
  const anomaly = findUnusualTransaction(historyRows, settings.alertSensitivity, exactWindow(now, 7).from);
  if (anomaly) {
    const sources = [transactionSource(anomaly.current), ...anomaly.baseline.map((item) => transactionSource(item, 'baseline'))];
    alerts.push({
      id: `unusual-${anomaly.current.id}`, type: 'unusual-amount', level: 'warning', priority: 80,
      title: 'یک مبلغ غیرعادی ثبت شده',
      detail: `${money(anomaly.current.amount)} تومان در «${anomaly.current.category}»؛ ${anomaly.ratio} برابر میانهٔ ${anomaly.baseline.length} ثبت مشابه.`,
      value: Number(anomaly.current.amount), unit: FINANCIAL_UNIT, scope: financialScope(historyWindow, 'خط مبنای ۹۰ روزه'), sources,
      action: { screen: 'ledger', tab: 'transactions', entityId: anomaly.current.id, label: 'بازبینی ثبت' },
    });
  }

  // DNA تا امروز فقط تماشا می‌شد. ستون فقرات هزینه — دسته‌ای که تقریباً هر ماه
  // تکرار شده — تنها جایی است که نبودِ یک ثبت، خودش خبر است: اجاره‌ای که این ماه
  // نیامده یعنی یا پرداخت نشده یا ثبت نشده، و هر دو کار دارند.
  const profiles = dnaProfiles({ now });
  const fiscalMonth = periodForDate(now, currentTimeZone());
  const recordedThisMonth = historyRows.filter((item) => periodForDate(item.occurredAt, currentTimeZone()) === fiscalMonth);
  const persianDayOfMonth = Number(new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: currentTimeZone(), day: 'numeric' }).format(now));
  for (const missing of overdueBackboneCategories(profiles, recordedThisMonth, { dayOfMonth: persianDayOfMonth }).slice(0, 2)) {
    const evidence = historyRows.filter((item) => item.type === 'expense' && item.category === missing.category);
    alerts.push({
      id: `missing-recurring-${missing.category}`, type: 'missing-recurring', level: 'info', priority: 65,
      title: `«${missing.category}» این ماه هنوز ثبت نشده`,
      detail: `در ${missing.months} ماه از ${profiles.months} ماه گذشته ثبت شده و معمولاً حدود روز ${missing.typicalDay} ماه می‌آید؛ مبلغ معمولش ${money(missing.median)} تومان است.`,
      value: missing.median, unit: FINANCIAL_UNIT,
      scope: financialScope(historyWindow, 'الگوی تکرار همین پرونده'),
      sources: evidence.map(transactionSource),
      action: { screen: 'ledger', tab: 'transactions', label: 'ثبت این هزینه' },
    });
  }

  const currentWeekWindow = exactWindow(now, 7);
  const previousWeekWindow = exactWindow(now, 7, 7);
  const currentWeekExpenses = financialTransactionRows(currentWeekWindow, { type: 'expense' });
  const previousWeekExpenses = financialTransactionRows(previousWeekWindow, { type: 'expense' });
  const growth = detectExpenseGrowth(currentWeekExpenses, previousWeekExpenses, settings.alertSensitivity);
  if (growth) {
    const sources = [...currentWeekExpenses.map(transactionSource), ...previousWeekExpenses.map((item) => transactionSource(item, 'previous'))];
    alerts.push({
      id: 'expense-growth', type: 'expense-growth', level: 'warning', priority: 70,
      title: `هزینهٔ هفت روز اخیر ${growth.percent}٪ رشد کرده`, detail: `${money(growth.delta)} تومان بیشتر از هفت روز قبل خرج شده است.`,
      value: growth.current, unit: FINANCIAL_UNIT,
      scope: { ...financialScope(currentWeekWindow, 'هفت روز اخیر در مقایسه با هفت روز قبل'), comparisonFrom: previousWeekWindow.from, comparisonTo: previousWeekWindow.to },
      sources, action: { screen: 'report', label: 'دیدن گزارش', target: 'expenses' },
    });
  }

  // دفتری که هنوز هیچ پولی در آن جابه‌جا نشده، «کم‌پول» نیست — خالی است.
  //
  // هشدار نقدینگی روی دفتر تازه، اولین چیزی است که کاربر می‌بیند و هیچ معنایی
  // ندارد؛ همان قاعدهٔ «بدون دادهٔ کافی هیچ ادعایی» که DNA رعایت می‌کند.
  const ledgerHasMoved = Boolean(db.prepare("SELECT 1 FROM transactions WHERE status!='deleted' LIMIT 1").get())
    || liquidAccounts.some((account) => Number(account.openingBalance || 0) !== 0);
  if (ledgerHasMoved && cash < Number(settings.lowBalanceThreshold || 2_000_000)) {
    alerts.push({
      id: 'low-cash', type: 'low-cash', level: 'warning', priority: 60,
      title: 'ماندهٔ نقدی به حد هشدار رسیده', detail: `${money(cash)} تومان مانده در برابر حد ${money(settings.lowBalanceThreshold || 2_000_000)} تومان.`,
      value: cash, unit: FINANCIAL_UNIT, scope: sourceScope(accountSources(liquidAccounts), now, 'ماندهٔ حساب‌های نقدی تا اکنون'), sources: accountSources(liquidAccounts),
      action: { screen: 'report', label: 'بررسی نقدینگی', target: 'runway' },
    });
  }

  const baseRunway = runway.scenarios.find((item) => item.id === 'base')?.days ?? null;
  if (baseRunway != null && baseRunway <= 14) {
    alerts.push({
      id: 'short-runway', type: 'short-runway', level: baseRunway <= 7 ? 'danger' : 'warning', priority: 65,
      title: `دوام نقدینگی پایه حدود ${baseRunway} روز است`, detail: 'این سناریو درآمد آینده را فرض نمی‌کند و از میانگین هزینهٔ ۳۰ روز اخیر ساخته شده است.',
      value: baseRunway, unit: 'روز', scope: monthScope, sources: runway.sources,
      action: { screen: 'report', label: 'دیدن سناریوها', target: 'runway' },
    });
  }

  const snoozedIds = snoozedFinancialAlertIds(now);
  const visibleAlerts = alerts.filter((item) => !snoozedIds.has(item.id)).sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  return {
    cash, receivable, payable, overdue: overdueItems.length,
    cashBasis: true, basisLabel: 'مبنای دریافت و پرداخت', unit: FINANCIAL_UNIT, accounts,
    runway, runwayDays: baseRunway, month, monthScope, alerts: visibleAlerts, priorityAlert: prioritizeAlerts(visibleAlerts),
    alertSensitivity: settings.alertSensitivity || 'balanced', disclaimer: FINANCIAL_DISCLAIMER,
  };
}

export function answerFinancialQuestion(question = '', { now = new Date() } = {}) {
  const original = String(question || '').trim().slice(0, 500);
  const normalized = normalizePersian(original).toLowerCase();
  if (isGuardedAdviceQuestion(normalized)) {
    return financialAnswer({
      question: original, intent: 'guarded-advice',
      answer: 'می‌توانم ارقام ثبت‌شده را با منبع نشان بدهم، اما دربارهٔ مالیات یا موضوع حقوقی حکم قطعی نمی‌دهم. برای تصمیم رسمی، گزارش را با حسابدار یا مشاور حقوقی بررسی کن.',
      now, disclaimer: 'این پاسخ توصیهٔ مالیاتی یا حقوقی نیست و هیچ عددی خارج از دفتر محاسبه نشده است.',
    });
  }

  const currentWindow = exactWindow(now, 30);
  const scope = financialScope(currentWindow, '۳۰ روز اخیر');
  const rows = financialTransactionRows(currentWindow);
  const overview = financialOverview(now);
  const contacts = listContacts();
  const matchedContact = contacts.find((item) => normalized.includes(normalizePersian(item.name).toLowerCase()));
  const categories = getCategories().sort((left, right) => right.name.length - left.name.length);
  const matchedCategory = categories.find((item) => normalized.includes(normalizePersian(item.name).toLowerCase()));

  if (/آخرین.*(پرداخت|خرج|هزینه)|آخرین پرداخت/.test(normalized)) {
    const item = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
      transactions.raw_text AS rawText,transactions.occurred_at AS occurredAt,accounts.name AS accountName
      FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
      WHERE transactions.status!='deleted' AND transactions.type='expense' ORDER BY transactions.occurred_at DESC LIMIT 1`).get();
    const sources = item ? [transactionSource(item)] : [];
    const first = db.prepare("SELECT MIN(occurred_at) AS occurredAt FROM transactions WHERE status!='deleted'").get();
    const range = { ...sourceScope(sources, now, 'از اولین ثبت تا اکنون'), from: first.occurredAt || null };
    return financialAnswer({ question: original, intent: 'latest-payment',
      answer: item ? `آخرین پرداخت ${money(item.amount)} تومان برای «${item.category}» بوده است.` : 'هنوز پرداختی در دفتر ثبت نشده است.',
      result: { value: Number(item?.amount || 0), label: 'آخرین پرداخت', unit: FINANCIAL_UNIT }, scope: range, sources,
      calculation: 'آخرین تراکنش هزینه بر اساس زمان ثبت', now });
  }

  if (matchedContact && /مانده|طلب|بده|حساب/.test(normalized)) {
    const obligations = listObligations({ status: 'open' }).filter((item) => item.contactId === matchedContact.id);
    const invoices = listInvoices().items.filter((item) => item.contactId === matchedContact.id && !['draft', 'cancelled', 'paid'].includes(item.displayStatus) && item.balanceDue > 0);
    const sources = [...obligations.map(obligationSource), ...invoices.map(invoiceSource)];
    const value = sources.reduce((sum, item) => sum + (item.direction === 'receivable' ? item.amount : -item.amount), 0);
    const direction = value > 0 ? `${money(value)} تومان از او طلب داری` : value < 0 ? `${money(Math.abs(value))} تومان به او بدهکاری` : 'ماندهٔ بازی با او ثبت نشده است';
    return financialAnswer({ question: original, intent: 'contact-balance', answer: `ماندهٔ «${matchedContact.name}»: ${direction}.`,
      result: { value, label: `ماندهٔ ${matchedContact.name}`, unit: FINANCIAL_UNIT }, scope: sourceScope(sources, now), sources,
      calculation: 'طلب‌های باز منهای بدهی‌های باز شخص؛ شامل ماندهٔ فاکتورهای صادرشده', now });
  }

  if (matchedCategory) {
    const selected = rows.filter((item) => item.category === matchedCategory.name && item.type === matchedCategory.type);
    const value = selected.reduce((sum, item) => sum + Number(item.amount), 0);
    const sources = selected.map(transactionSource);
    return financialAnswer({ question: original, intent: 'category-total',
      answer: `جمع «${matchedCategory.name}» در ۳۰ روز اخیر ${money(value)} تومان از ${sources.length} ثبت است.`,
      result: { value, label: matchedCategory.name, unit: FINANCIAL_UNIT, type: matchedCategory.type }, scope, sources,
      calculation: `جمع مبلغ تراکنش‌های دستهٔ ${matchedCategory.name}`, now });
  }

  if (/مقایسه|بازه قبل|ماه قبل|نسبت/.test(normalized)) {
    const previousWindow = exactWindow(now, 30, 30);
    const previousRows = financialTransactionRows(previousWindow);
    const type = /هزینه|خرج/.test(normalized) ? 'expense' : /درآمد|فروش/.test(normalized) ? 'income' : '';
    const sum = (items) => items.filter((item) => !type || item.type === type).reduce((total, item) => total + (type ? Number(item.amount) : item.type === 'income' ? Number(item.amount) : -Number(item.amount)), 0);
    const current = sum(rows);
    const previous = sum(previousRows);
    const changePercent = previous !== 0 ? Math.round(((current - previous) / Math.abs(previous)) * 100) : null;
    const label = type === 'expense' ? 'هزینه' : type === 'income' ? 'درآمد' : 'خالص دریافت و پرداخت';
    const sources = [...rows.filter((item) => !type || item.type === type).map(transactionSource), ...previousRows.filter((item) => !type || item.type === type).map((item) => transactionSource(item, 'previous'))];
    const comparisonText = changePercent == null ? 'برای درصد تغییر، بازهٔ قبل دادهٔ کافی ندارد' : `${Math.abs(changePercent)}٪ ${changePercent >= 0 ? 'بیشتر' : 'کمتر'} از بازهٔ قبل`;
    return financialAnswer({ question: original, intent: 'range-comparison', answer: `${label} ۳۰ روز اخیر ${money(current)} تومان است؛ ${comparisonText}.`,
      result: { value: current, previousValue: previous, changePercent, label, unit: FINANCIAL_UNIT },
      scope: { ...scope, comparisonFrom: previousWindow.from, comparisonTo: previousWindow.to }, sources,
      calculation: `جمع ${label} در دو بازهٔ ۳۰ روزهٔ پشت‌سرهم`, now });
  }

  if (/بده|طلب|گرفتن|دادن/.test(normalized)) {
    const obligations = listObligations({ status: 'open' });
    const invoices = listInvoices().items.filter((item) => !['draft', 'cancelled', 'paid'].includes(item.displayStatus) && item.balanceDue > 0);
    const sources = [...obligations.map(obligationSource), ...invoices.map(invoiceSource)];
    return financialAnswer({ question: original, intent: 'open-balances',
      answer: `در حال حاضر ${money(overview.receivable)} تومان طلب باز و ${money(overview.payable)} تومان بدهی باز داری.`,
      result: { value: overview.receivable - overview.payable, receivable: overview.receivable, payable: overview.payable, label: 'خالص مطالبات باز', unit: FINANCIAL_UNIT },
      scope: sourceScope(sources, now), sources, calculation: 'جمع طلب‌های باز و فاکتورهای فروش منهای بدهی‌های باز و فاکتورهای خرید', now });
  }

  if (/هزینه|خرج/.test(normalized)) {
    const expenseRows = rows.filter((item) => item.type === 'expense');
    const value = expenseRows.reduce((sum, item) => sum + Number(item.amount), 0);
    const byCategory = new Map();
    for (const item of expenseRows) byCategory.set(item.category, (byCategory.get(item.category) || 0) + Number(item.amount));
    const top = [...byCategory.entries()].sort((left, right) => right[1] - left[1])[0];
    const answer = /بیشترین/.test(normalized) && top ? `بیشترین هزینهٔ ۳۰ روز اخیر «${top[0]}» با ${money(top[1])} تومان بوده است.` : `جمع هزینهٔ ۳۰ روز اخیر ${money(value)} تومان از ${expenseRows.length} ثبت است.`;
    const answerSources = /بیشترین/.test(normalized) && top ? expenseRows.filter((item) => item.category === top[0]) : expenseRows;
    return financialAnswer({ question: original, intent: /بیشترین/.test(normalized) ? 'top-expense' : 'expense-total', answer,
      result: { value: /بیشترین/.test(normalized) && top ? top[1] : value, label: /بیشترین/.test(normalized) ? top?.[0] || 'بیشترین هزینه' : 'هزینه', unit: FINANCIAL_UNIT },
      scope, sources: answerSources.map(transactionSource), calculation: /بیشترین/.test(normalized) ? 'جمع هزینه‌ها به تفکیک دسته و انتخاب بیشترین' : 'جمع تراکنش‌های هزینه', now });
  }

  if (/درآمد|فروش/.test(normalized)) {
    const incomeRows = rows.filter((item) => item.type === 'income');
    const value = incomeRows.reduce((sum, item) => sum + Number(item.amount), 0);
    return financialAnswer({ question: original, intent: 'income-total', answer: `در ۳۰ روز اخیر ${money(value)} تومان درآمد از ${incomeRows.length} ثبت داشته‌ای.`,
      result: { value, label: 'درآمد', unit: FINANCIAL_UNIT }, scope, sources: incomeRows.map(transactionSource), calculation: 'جمع تراکنش‌های درآمد', now });
  }

  const net = rows.reduce((sum, item) => sum + (item.type === 'income' ? Number(item.amount) : -Number(item.amount)), 0);
  if (/سود|وضع|چطور/.test(normalized)) {
    return financialAnswer({ question: original, intent: 'range-net-cash-flow',
      answer: `خالص دریافت و پرداخت ۳۰ روز اخیر ${money(net)} تومان است؛ این عدد سود حسابداری نیست.`,
      result: { value: net, label: 'خالص دریافت و پرداخت', unit: FINANCIAL_UNIT }, scope,
      sources: rows.map(transactionSource), calculation: 'جمع دریافت‌ها منهای جمع پرداخت‌های ۳۰ روز اخیر', now });
  }
  return financialAnswer({ question: original, intent: 'cash-position',
    answer: `ماندهٔ نقدی برآوردی ${money(overview.cash)} تومان است. می‌توانی دربارهٔ آخرین پرداخت، جمع یک دسته، ماندهٔ یک شخص یا مقایسهٔ دو بازه بپرسی.`,
    result: { value: overview.cash, netCashFlow: net, label: 'ماندهٔ نقدی برآوردی', unit: FINANCIAL_UNIT },
    scope: sourceScope(accountSources(overview.accounts), now, 'ماندهٔ حساب‌های نقدی تا اکنون'),
    sources: accountSources(overview.accounts), calculation: 'جمع ماندهٔ صندوق، بانک و کیف پول فعال؛ ماندهٔ افتتاحیه به‌علاوهٔ دریافت‌ها منهای پرداخت‌ها', now });
}
