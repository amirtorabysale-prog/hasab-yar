import { randomUUID } from 'node:crypto';
import { addLocalDays, audit, dayBounds, db, localDay } from './core.js';

export function previewDayClosing(values = {}) {
  const day = String(values.day || localDay()).slice(0, 10);
  const bounds = dayBounds(day);
  const previous = db.prepare('SELECT day,counted_cash AS countedCash FROM daily_closings WHERE day<? ORDER BY day DESC LIMIT 1').get(day);
  const cashAccount = db.prepare("SELECT opening_balance AS openingBalance FROM accounts WHERE id='cash'").get();
  const movementStart = previous ? dayBounds(addLocalDays(previous.day, 1)).start : null;
  const totals = movementStart
    ? db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS net
      FROM transactions WHERE status!='deleted' AND account_id='cash' AND occurred_at>=? AND occurred_at<?`).get(movementStart, bounds.endExclusive)
    : db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS net
      FROM transactions WHERE status!='deleted' AND account_id='cash' AND occurred_at<?`).get(bounds.endExclusive);
  const expectedCash = Number(previous?.countedCash ?? cashAccount?.openingBalance ?? 0) + Number(totals.net || 0);
  return { day, expectedCash, previousDay: previous?.day || null, previousCountedCash: previous?.countedCash ?? null };
}

export function closeDay(values = {}) {
  const preview = previewDayClosing(values);
  const { day, expectedCash } = preview;
  const countedCash = Math.max(0, Math.round(Number(values.countedCash) || 0));
  const difference = countedCash - expectedCash;
  const id = randomUUID();
  db.prepare(`INSERT INTO daily_closings (id,day,expected_cash,counted_cash,difference,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET expected_cash=excluded.expected_cash,counted_cash=excluded.counted_cash,difference=excluded.difference,note=excluded.note`)
    .run(id, day, expectedCash, countedCash, difference, String(values.note || '').slice(0, 500));
  const result = db.prepare('SELECT id,day,expected_cash AS expectedCash,counted_cash AS countedCash,difference,note,created_at AS createdAt FROM daily_closings WHERE day=?').get(day);
  audit('close', 'day', result.id, result);
  return result;
}

export function listDailyClosings() {
  return db.prepare('SELECT id,day,expected_cash AS expectedCash,counted_cash AS countedCash,difference,note,created_at AS createdAt FROM daily_closings ORDER BY day DESC LIMIT 60').all();
}
