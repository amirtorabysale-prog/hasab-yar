import { db, invalidInput } from './core.js';
import { listAccounts } from './accounts.js';

/**
 * کارت حساب یک حساب پولی — بانک، صندوق یا تنخواه — با مانده‌گیری تجمعی.
 *
 * همان قاعدهٔ کارت طرف حساب: منبع دفتر کل است، نه جمع‌زدن جدول تراکنش و
 * انتقال و افتتاحیه. هر چیزی که پول این حساب را جابه‌جا کرده سند دارد —
 * دریافت، پرداخت، انتقال، کارمزد، افتتاحیه و برگشت‌ها — پس کارت بی‌آنکه
 * منبعی را بشناسد کامل است.
 *
 * ستون «طرف مقابل» از خودِ سند می‌آید: حساب‌هایی که همان سند در سمت دیگر
 * زده است. بدون آن، کارت بانک فقط می‌گفت «۳۶ میلیون رفت» و نمی‌گفت کجا.
 *
 * بدهکار یعنی پول به حساب آمد، بستانکار یعنی رفت؛ مانده مثبت یعنی موجودی.
 */

const movement = (row) => Number(row.debit || 0) - Number(row.credit || 0);

function moneyLedgerAccounts(accountId) {
  return db.prepare(`SELECT id,code,name FROM ledger_accounts
    WHERE source_kind='operational-account' AND source_key=? ORDER BY code`).all(String(accountId));
}

export function moneyAccountCard(accountId, { from = '', to = '' } = {}) {
  const account = listAccounts().find((item) => item.id === String(accountId || ''));
  if (!account) throw invalidInput('این حساب پیدا نشد.', 'ACCOUNT_NOT_FOUND');

  const ledger = moneyLedgerAccounts(account.id);
  const ids = ledger.map((item) => item.id);
  const holes = ids.map(() => '?').join(',');
  const rows = !ids.length ? [] : db.prepare(`SELECT journal_lines.id,journal_lines.entry_id AS entryId,
      journal_entries.occurred_at AS occurredAt,journal_entries.memo,journal_entries.source_type AS sourceType,
      journal_entries.source_id AS sourceId,journal_entries.entry_kind AS entryKind,
      journal_lines.debit,journal_lines.credit,journal_lines.description
    FROM journal_lines JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    WHERE journal_lines.account_id IN (${holes})
    ORDER BY journal_entries.occurred_at,journal_entries.id,journal_lines.rowid`).all(...ids);

  // طرف مقابلِ هر سند: نام حساب‌های سمت دیگرِ همان سند، بی‌تکرار.
  const counterSides = new Map();
  const entryIds = [...new Set(rows.map((row) => row.entryId))];
  for (let index = 0; index < entryIds.length; index += 400) {
    const chunk = entryIds.slice(index, index + 400);
    const chunkHoles = chunk.map(() => '?').join(',');
    for (const line of db.prepare(`SELECT journal_lines.entry_id AS entryId,ledger_accounts.name
      FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE journal_lines.entry_id IN (${chunkHoles}) AND journal_lines.account_id NOT IN (${holes})
      ORDER BY journal_lines.rowid`).all(...chunk, ...ids)) {
      const names = counterSides.get(line.entryId) || [];
      if (!names.includes(line.name)) names.push(line.name);
      counterSides.set(line.entryId, names);
    }
  }

  const before = from ? rows.filter((row) => row.occurredAt < from) : [];
  const within = rows.filter((row) => (!from || row.occurredAt >= from) && (!to || row.occurredAt <= to));
  const opening = before.reduce((sum, row) => sum + movement(row), 0);
  let balance = opening;
  const lines = within.map((row) => {
    balance += movement(row);
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      title: String(row.description || row.memo || '').trim(),
      counterpart: (counterSides.get(row.entryId) || []).join('، '),
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      entryKind: row.entryKind,
      debit: Number(row.debit || 0),
      credit: Number(row.credit || 0),
      balance,
    };
  });

  return {
    account,
    opening,
    lines,
    period: { from, to },
    totals: {
      debit: lines.reduce((sum, line) => sum + line.debit, 0),
      credit: lines.reduce((sum, line) => sum + line.credit, 0),
      balance,
      documents: new Set(lines.map((line) => `${line.sourceType}:${line.sourceId}`)).size,
    },
    // فهرست حساب‌ها مانده را از تراکنش‌ها می‌سازد و کارت از دفتر کل. اختلاف یعنی
    // ثبتی هنوز سند نخورده (مثلاً در انتظار بررسی)؛ پنهان‌کردنش یعنی دو عدد
    // متناقض روی دو صفحه.
    reconciliation: from || to ? null : { listed: Number(account.balance || 0), ledger: balance, unexplained: Number(account.balance || 0) - balance },
  };
}
