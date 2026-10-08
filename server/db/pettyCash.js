import { randomUUID } from 'node:crypto';
import { postAccountTransferJournal } from '../accounting.js';
import { audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { listAccounts } from './accounts.js';

/**
 * تنخواه‌گردان — پولِ شرکت که دست یک نفر است.
 *
 * روش، تنخواه‌گردانیِ با سقف ثابت است (روش رایج دفترهای حسابداری):
 *
 * ۱. **پرداخت تنخواه:** به اندازهٔ سقف از بانک یا صندوق به دارنده — یک انتقال
 *    میان دو حساب خود شرکت، نه هزینه.
 * ۲. **خرج:** هر هزینه‌ای که دارنده از تنخواه می‌دهد، هزینهٔ عادی است ولی از
 *    حساب تنخواه کم می‌شود، نه از صندوق اصلی. همان مسیر ثبت روزانه و موتور
 *    تصمیم؛ فقط حسابِ پرداخت فرق دارد.
 * ۳. **شارژ:** دقیقاً به اندازهٔ خرج‌شده، تا تنخواه دوباره به سقفش برسد.
 * ۴. **بستن:** باقی‌مانده به بانک یا صندوق برمی‌گردد. اگر دارنده بیش از
 *    تنخواه خرج کرده، همان کسری به او پرداخت می‌شود تا مانده صفر شود.
 *
 * هر تنخواه یک حساب عادی است که جدول `petty_cash_funds` آن را تنخواه می‌شناسد.
 * همین باعث می‌شود مانده، انتقال، انتخاب حساب روی برگهٔ تأیید و سند دفتر کل
 * همه از مسیرهای آزموده‌شدهٔ حساب‌ها بیایند و نسخهٔ دومی ساخته نشود. حساب
 * دفتر کلِ هر تنخواه زیر معین «تنخواه‌گردان» می‌نشیند.
 */

const normalizeName = (value) => String(value || '').replace(/[\s‌]+/g, ' ').trim();

function fundRow(accountId) {
  return db.prepare(`SELECT f.account_id AS id, f.holder_name AS holderName, f.ceiling, f.status, f.note,
    f.created_at AS createdAt, f.closed_at AS closedAt, a.name AS accountName, a.active
    FROM petty_cash_funds f JOIN accounts a ON a.id=f.account_id WHERE f.account_id=?`).get(String(accountId || ''));
}

function balanceOf(accountId) {
  return Number(listAccounts().find((account) => account.id === accountId)?.balance || 0);
}

function sourceAccount(accountId, label) {
  const account = db.prepare(`SELECT accounts.id,accounts.name,accounts.active,petty.account_id AS pettyId FROM accounts
    LEFT JOIN petty_cash_funds petty ON petty.account_id=accounts.id WHERE accounts.id=?`).get(String(accountId || ''));
  if (!account || !account.active) throw invalidInput(`${label} انتخاب نشده یا فعال نیست.`);
  if (account.pettyId) throw invalidInput('تنخواه را از تنخواهِ دیگر شارژ نکن؛ از بانک یا صندوق انتخاب کن.');
  return account;
}

function transfer({ fromAccountId, toAccountId, amount, occurredAt, memo }) {
  return postAccountTransferJournal(db, {
    transferId: randomUUID(), fromAccountId, toAccountId, amount, occurredAt: occurredAt || new Date().toISOString(), memo,
  }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
}

function describe(fund) {
  const balance = balanceOf(fund.id);
  const spends = db.prepare(`SELECT id,amount,category,raw_text AS text,occurred_at AS occurredAt FROM transactions
    WHERE account_id=? AND status!='deleted' AND type='expense' ORDER BY occurred_at DESC LIMIT 20`).all(fund.id);
  return {
    ...fund, active: Boolean(fund.active), balance,
    // در تنخواه‌گردانی با سقف ثابت، کسری تا سقف همان مبلغی است که خرج شده و
    // باید شارژ شود.
    spent: Math.max(0, fund.ceiling - balance),
    overspent: balance < 0 ? -balance : 0,
    recentSpends: spends,
  };
}

export function listPettyCashFunds({ includeClosed = false } = {}) {
  const rows = db.prepare(`SELECT account_id AS id FROM petty_cash_funds ${includeClosed ? '' : "WHERE status='open'"} ORDER BY created_at`).all();
  return rows.map(({ id }) => describe(fundRow(id)));
}

/**
 * تنخواهِ تازه: حساب دارنده ساخته می‌شود و به اندازهٔ سقف از بانک یا صندوق
 * به آن منتقل می‌شود. برای هر دارنده فقط یک تنخواهِ باز.
 */
export function openPettyCashFund({ holderName, ceiling, fromAccountId, occurredAt = '', note = '' } = {}) {
  const holder = normalizeName(holderName).slice(0, 60);
  if (holder.length < 2) throw invalidInput('نام دارندهٔ تنخواه را وارد کن.');
  if (!(Number(ceiling) > 0)) throw invalidInput('سقف تنخواه را وارد کن.');
  const amount = cleanAmount(ceiling);
  const from = sourceAccount(fromAccountId, 'حساب پرداخت تنخواه');
  const existing = db.prepare("SELECT account_id FROM petty_cash_funds WHERE status='open' AND holder_name=?").get(holder);
  if (existing) throw Object.assign(new Error(`تنخواهِ باز «${holder}» از قبل هست؛ آن را شارژ کن.`), { code: 'PETTY_CASH_EXISTS', status: 409, details: { id: existing.account_id } });
  const id = `petty-${randomUUID()}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO accounts (id,name,kind,opening_balance,active) VALUES (?,?,'other',0,1)").run(id, freeAccountName(`تنخواه ${holder}`));
    db.prepare('INSERT INTO petty_cash_funds (account_id,holder_name,ceiling,note) VALUES (?,?,?,?)').run(id, holder, amount, String(note || '').slice(0, 300));
    transfer({ fromAccountId: from.id, toAccountId: id, amount, occurredAt, memo: `پرداخت تنخواه به ${holder}` });
    audit('create', 'petty-cash', id, { holder, ceiling: amount, from: from.id });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return describe(fundRow(id));
}

/** نام حساب یکتاست؛ تنخواهِ بسته‌شدهٔ همین دارنده نامش را نگه داشته است. */
function freeAccountName(base) {
  const taken = (name) => db.prepare('SELECT 1 FROM accounts WHERE name=?').get(name);
  if (!taken(base)) return base;
  for (let index = 2; index < 100; index += 1) if (!taken(`${base} (${index})`)) return `${base} (${index})`;
  return `${base} ${randomUUID().slice(0, 6)}`;
}

function openFund(id) {
  const fund = fundRow(id);
  if (!fund) throw Object.assign(new Error('تنخواه پیدا نشد.'), { code: 'PETTY_CASH_MISSING', status: 404 });
  if (fund.status !== 'open') throw Object.assign(new Error('این تنخواه بسته شده است.'), { code: 'PETTY_CASH_CLOSED', status: 409 });
  return fund;
}

/**
 * شارژ تنخواه. پیش‌فرض، همان مبلغِ خرج‌شده است تا تنخواه به سقفش برگردد؛
 * مبلغ دیگری هم پذیرفته می‌شود — مثلاً شارژِ نیمه — ولی هیچ‌وقت صفر یا منفی.
 */
export function replenishPettyCashFund(id, { fromAccountId, amount = null, occurredAt = '' } = {}) {
  const fund = openFund(id);
  const from = sourceAccount(fromAccountId, 'حساب شارژ تنخواه');
  const balance = balanceOf(fund.id);
  const value = amount == null || amount === '' ? fund.ceiling - balance : cleanAmount(amount);
  if (!(value > 0)) throw invalidInput('تنخواه پر است؛ چیزی برای شارژ نمانده.');
  db.exec('BEGIN IMMEDIATE');
  try {
    transfer({ fromAccountId: from.id, toAccountId: fund.id, amount: value, occurredAt, memo: `شارژ تنخواه ${fund.holderName}` });
    audit('replenish', 'petty-cash', fund.id, { amount: value, from: from.id });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return describe(fundRow(fund.id));
}

export function updatePettyCashCeiling(id, { ceiling } = {}) {
  const fund = openFund(id);
  if (!(Number(ceiling) > 0)) throw invalidInput('سقف تنخواه را وارد کن.');
  const value = cleanAmount(ceiling);
  db.prepare('UPDATE petty_cash_funds SET ceiling=? WHERE account_id=?').run(value, fund.id);
  audit('update', 'petty-cash', fund.id, { ceiling: value });
  return describe(fundRow(fund.id));
}

/**
 * بستن تنخواه: باقی‌مانده به بانک یا صندوق برمی‌گردد، یا کسریِ خرجِ بیش از
 * تنخواه به دارنده پرداخت می‌شود؛ سپس حساب غیرفعال می‌شود.
 */
export function closePettyCashFund(id, { toAccountId, occurredAt = '' } = {}) {
  const fund = openFund(id);
  const target = sourceAccount(toAccountId, 'حساب برگشت تنخواه');
  const balance = balanceOf(fund.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (balance > 0) transfer({ fromAccountId: fund.id, toAccountId: target.id, amount: balance, occurredAt, memo: `برگشت باقی‌ماندهٔ تنخواه ${fund.holderName}` });
    if (balance < 0) transfer({ fromAccountId: target.id, toAccountId: fund.id, amount: -balance, occurredAt, memo: `پرداخت کسری تنخواه به ${fund.holderName}` });
    db.prepare('UPDATE accounts SET active=0 WHERE id=?').run(fund.id);
    db.prepare("UPDATE petty_cash_funds SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE account_id=?").run(fund.id);
    audit('close', 'petty-cash', fund.id, { balance, to: target.id });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return describe(fundRow(fund.id));
}

/**
 * «تنخواه به رضایی دادیم» از گفتار: اگر رضایی تنخواهِ باز دارد شارژ می‌شود، وگرنه
 * تنخواهِ تازه با همان مبلغ به‌عنوان سقف ساخته می‌شود.
 */
export function fundPettyCashFromSpeech({ holderName, amount, fromAccountId, occurredAt = '' } = {}) {
  const holder = normalizeName(holderName);
  // بی‌نام فقط وقتی معنا دارد که دفتر یک تنخواهِ باز بیشتر ندارد: «تنخواه رو شارژ کردیم».
  const openFunds = db.prepare("SELECT account_id AS id,holder_name AS holder FROM petty_cash_funds WHERE status='open'").all();
  const open = holder ? openFunds.find((fund) => fund.holder === holder) : openFunds.length === 1 ? openFunds[0] : null;
  if (!holder && !open) throw invalidInput(openFunds.length ? 'چند تنخواه باز هست؛ بگو تنخواهِ چه کسی.' : 'نام دارندهٔ تنخواه را بگو.');
  if (open) return { action: 'replenished', item: replenishPettyCashFund(open.id, { fromAccountId, amount, occurredAt }) };
  return { action: 'opened', item: openPettyCashFund({ holderName: holder, ceiling: amount, fromAccountId, occurredAt }) };
}
