import { audit, currentWorkspace, db, getSettings, invalidInput, ledgerAmountUnit, setWorkspaceProfileType } from './core.js';
import { resolveAutomationPolicy } from '../../shared/automationPolicy.js';
import { AMOUNT_UNITS, convertAmount, normalizeAmountUnit, unitLabel } from '../../shared/amountUnit.js';

// هر جدولی که مبلغی به واحد دفتر نگه می‌دارد. تا یکی از آن‌ها ردیف دارد، واحد عوض
// نمی‌شود؛ وگرنه عددهای قبلی بی‌صدا ده برابر یا یک‌دهم خوانده می‌شدند.
const AMOUNT_TABLES = Object.freeze([
  'transactions', 'journal_entries', 'obligations', 'invoices', 'invoice_payments', 'receipts', 'cheques',
  'recurring_rules', 'financial_events', 'understanding_cases', 'bank_statement_lines', 'petty_cash_funds',
  'stock_movements', 'recognition_schedule_items', 'payroll_runs', 'daily_closings',
]);

/** شمار ردیف‌های مبلغ‌دار این دفتر، فقط آن‌هایی که صفر نیستند. */
export function amountRecordsInLedger() {
  const counts = {};
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  for (const table of AMOUNT_TABLES) {
    if (!exists.get(table)) continue;
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    if (count) counts[table] = count;
  }
  const opening = Number(db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE opening_balance<>0').get().count);
  if (opening) counts.openingBalances = opening;
  if (exists.get('products')) {
    const priced = Number(db.prepare('SELECT COUNT(*) AS count FROM products WHERE buy_price<>0 OR sale_price<>0 OR average_cost<>0 OR inventory_value<>0').get().count);
    if (priced) counts.pricedProducts = priced;
  }
  return counts;
}

/**
 * عوض کردن واحد مبلغ دفتر — فقط پیش از اولین مبلغ.
 *
 * دو تنظیمی که خودشان مبلغ‌اند (حد هشدار مانده و حد سرمایه‌ای شدن) همراه واحد
 * تبدیل می‌شوند تا همان معنای قبلی را بدهند.
 */
export function setLedgerAmountUnit(value) {
  if (!Object.hasOwn(AMOUNT_UNITS, value)) throw invalidInput('واحد مبلغ دفتر باید «تومان» یا «ریال» باشد.', 'AMOUNT_UNIT_INVALID');
  const previous = ledgerAmountUnit();
  const next = normalizeAmountUnit(value);
  if (previous === next) return { amountUnit: next, label: unitLabel(next), changed: false };
  const records = amountRecordsInLedger();
  if (Object.keys(records).length) {
    throw Object.assign(invalidInput(
      `واحد مبلغ فقط در دفتری عوض می‌شود که هنوز هیچ مبلغی ندارد؛ این دفتر به ${unitLabel(previous)} مبلغ ثبت‌شده دارد.`,
      'AMOUNT_UNIT_LOCKED',
    ), { status: 409, details: { records } });
  }
  const scale = (amount) => convertAmount(amount, previous, next) ?? Math.round(Number(amount) * AMOUNT_UNITS[next].perToman / AMOUNT_UNITS[previous].perToman);
  const settings = getSettings();
  const policy = (() => { try { return JSON.parse(settings.automationPolicy || '{}'); } catch { return {}; } })();
  const write = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.exec('BEGIN IMMEDIATE');
  try {
    write.run('amountUnit', next);
    if (Number(settings.lowBalanceThreshold) > 0) write.run('lowBalanceThreshold', String(scale(settings.lowBalanceThreshold)));
    if (Number(policy.capitalizationThreshold) > 0) {
      write.run('automationPolicy', JSON.stringify({ ...policy, capitalizationThreshold: scale(policy.capitalizationThreshold) }));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit('update', 'settings', 'amountUnit', { from: previous, to: next });
  return { amountUnit: next, label: unitLabel(next), changed: true };
}

/**
 * سیاست خودکارسازی این دفتر.
 *
 * سیاست ذخیره‌نشده یا خرابْ دروازه را باز نمی‌کند؛ `resolveAutomationPolicy`
 * هر مقدار نامعتبر را به پیش‌فرض امن برمی‌گرداند.
 */
export function automationPolicy() {
  let stored = {};
  try { stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='automationPolicy'").get()?.value || '{}'); }
  catch { stored = {}; }
  return resolveAutomationPolicy(stored);
}

/**
 * تغییر سیاست.
 *
 * هر تغییر در Audit Log می‌نشیند: این اعداد تعیین می‌کنند چه چیزی بدون نگاه
 * انسان وارد دفتر می‌شود، پس «چه کسی و کی عوضش کرد» بخشی از زنجیرهٔ حسابرسی است.
 */
export function saveAutomationPolicy(values = {}) {
  const previous = automationPolicy();
  const next = resolveAutomationPolicy({
    autoThreshold: values.autoThreshold,
    confirmThreshold: values.confirmThreshold,
    neverAutomatic: values.neverAutomatic,
    allowAiOnlyAutoPost: values.allowAiOnlyAutoPost,
    minimumAmountCertainty: values.minimumAmountCertainty,
    manualOnly: values.manualOnly,
    // بدون این، فلگ ساخته شده ولی کلید ندارد: هر مقداری که بفرستی بی‌صدا دور
    // ریخته می‌شود و موتور تصمیم هیچ‌وقت روشن نمی‌شود.
    engineV2: values.engineV2,
    shadowMode: values.shadowMode,
    capitalizationThreshold: values.capitalizationThreshold,
    // مقدار نفرستاده یعنی همان قبلی؛ ذخیرهٔ آستانه نباید فهم AI را خاموش کند.
    understandingMode: values.understandingMode ?? previous.understandingMode,
    understandingScope: values.understandingScope ?? previous.understandingScope,
  });
  db.prepare("INSERT INTO settings (key,value) VALUES ('automationPolicy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(next));
  audit('update', 'automation-policy', 'automationPolicy', {
    from: { autoThreshold: previous.autoThreshold, confirmThreshold: previous.confirmThreshold, capitalizationThreshold: previous.capitalizationThreshold, understandingMode: previous.understandingMode, understandingScope: previous.understandingScope },
    to: { autoThreshold: next.autoThreshold, confirmThreshold: next.confirmThreshold, capitalizationThreshold: next.capitalizationThreshold, understandingMode: next.understandingMode, understandingScope: next.understandingScope },
  });
  return next;
}

export function saveSettings(values) {
  const allowed = ['businessName', 'currency', 'timezone', 'profileType', 'onboardingDone', 'openingBalance', 'ownerName', 'lowBalanceThreshold', 'alertSensitivity'];
  const statement = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const key of allowed) if (values[key] != null) {
      if (key === 'profileType' && !['business', 'personal'].includes(values[key])) throw invalidInput('نوع دفتر معتبر نیست.');
      const value = key === 'alertSensitivity' && !['low', 'balanced', 'high'].includes(values[key]) ? 'balanced' : values[key];
      statement.run(key, String(value).slice(0, 120));
    }
    if (values.openingBalance != null) {
      const opening = Math.round(Number(values.openingBalance));
      if (!Number.isSafeInteger(opening)) throw invalidInput('ماندهٔ ابتدای دوره معتبر نیست.');
      db.prepare("UPDATE accounts SET opening_balance=?,updated_at=CURRENT_TIMESTAMP WHERE id='cash'").run(opening);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // منو از ردیف workspaces ساخته می‌شود؛ بدون این، تغییر نوع دفتر در منو دیده نمی‌شد.
  if (values.profileType != null) setWorkspaceProfileType(currentWorkspace()?.id || 'primary', values.profileType);
  return getSettings();
}

/**
 * کلید «همه را اول AI بفهمد» در صفحهٔ ثبت.
 *
 * روشن: هر گفته — ساده یا مرکب، صوتی یا تایپی — اول به فهم رویداد می‌رود و
 * خروجی ساخت‌یافته‌اش به موتور قاعده داده می‌شود؛ موتور تصمیم (نسخهٔ ۲) هم که
 * پیش‌نیاز این مسیر است روشن می‌شود. خاموش: فقط گفته‌های مرکب به AI می‌روند و
 * بقیه از مسیر قطعی و رایگان. بقیهٔ سیاست دفتر دست نمی‌خورد.
 */
export function setUnderstandingForAll(on) {
  const current = automationPolicy();
  return saveAutomationPolicy({
    ...current,
    neverAutomatic: [...current.neverAutomatic],
    understandingMode: on ? 'active' : current.understandingMode,
    understandingScope: on ? 'all' : 'composite',
    engineV2: on ? true : current.engineV2,
  });
}
