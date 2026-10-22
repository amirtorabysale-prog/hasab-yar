// ثبت احتمالاً تکراری: شباهت متن و مبلغ در چند دقیقهٔ اخیر.
//
// از server/db/transactions.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// transactions همه از همان server/db/transactions.js می‌خوانند.

import { resolveAccountId } from '../accounts.js';
import { currentTimeZone, db } from '../core.js';
import { normalizePersian } from '../../../shared/parser.js';
import { likelyDuplicates } from '../../duplicateGuard.js';

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
    const recent = candidates.map((candidate) => ({ candidate, similarity: textSimilarity(`${incomingText} ${item.category || ''}`, `${candidate.rawText} ${candidate.category || ''}`) }))
      .find((entry) => entry.similarity >= 0.42);
    if (recent) {
      duplicates.push({ inputIndex, ...recent.candidate, similarity: Math.round(recent.similarity * 100), reason: 'recent' });
      continue;
    }
    // «اجارهٔ مهر» که روز قبل یا از صف حسابدار ثبت شده: همان مبلغ و دسته در همین دوره.
    const earlier = likelyDuplicates(db, { ...item, amount, accountId, occurredAt }, { timeZone: currentTimeZone() })[0];
    if (earlier) duplicates.push({ inputIndex, ...earlier });
  }
  return duplicates;
}
