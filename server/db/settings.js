import { audit, currentWorkspace, db, getSettings, invalidInput, setWorkspaceProfileType } from './core.js';
import { resolveAutomationPolicy } from '../../shared/automationPolicy.js';

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
  });
  db.prepare("INSERT INTO settings (key,value) VALUES ('automationPolicy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(next));
  audit('update', 'automation-policy', 'automationPolicy', {
    from: { autoThreshold: previous.autoThreshold, confirmThreshold: previous.confirmThreshold },
    to: { autoThreshold: next.autoThreshold, confirmThreshold: next.confirmThreshold },
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
