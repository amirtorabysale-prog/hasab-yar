/** Only controlled journals can support a payment, at the event's accounting date. */
export function availableReviewedBalance(database, accountId, occurredAt, normalSide='debit') {
  if(!accountId || !occurredAt) return 0;
  const row=database.prepare(`SELECT COALESCE(SUM(l.debit-l.credit),0) currentBalance,
    COALESCE(SUM(CASE WHEN substr(j.occurred_at,1,10)<=? THEN l.debit-l.credit ELSE 0 END),0) historicalBalance
    FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
    WHERE l.account_id=? AND j.approval_state='approved'`).get(String(occurredAt).slice(0,10),accountId);
  const sign=normalSide==='credit'?-1:1;
  return Math.max(0,Math.min(sign*row.currentBalance,sign*row.historicalBalance));
}
