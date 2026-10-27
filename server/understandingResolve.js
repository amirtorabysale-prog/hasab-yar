import { matchCounterparty } from './counterparties.js';
import { counterpartyLedgerBalance } from './db/counterpartyCard.js';
import { listAccounts } from './db/accounts.js';
import { db } from './db/core.js';
import { detectBank } from '../shared/banks.js';
import { canonicalCounterpartyName } from '../shared/counterpartyIdentity.js';
import { pickPettyCashAccount } from '../shared/pettyCashSpeech.js';
import { topicParts } from '../shared/topicParts.js';
import { topicLabelKey } from './chartOfAccounts.js';

/**
 * نامی که مدل گفته → شناسهٔ واقعیِ همین دفتر.
 *
 * مدل نام می‌گوید و این‌جا تطبیق می‌خورد؛ هیچ شناسه‌ای از مدل پذیرفته نمی‌شود و
 * هیچ شناسه‌ای به مدل داده نمی‌شود. هر جا تطبیق یکتا نباشد، به‌جای حدس، وضعیت
 * «مبهم» یا «تعریف‌نشده» برمی‌گردد تا نقشهٔ پرونده سؤال بسازد.
 *
 * حساب‌ها فقط از همین دفتر خوانده می‌شوند — `db` به دیتابیسِ دفترِ فعال اشاره
 * می‌کند، پس حساب دفتر دیگر حتی دیده نمی‌شود.
 */
export function resolveUnderstanding(understanding) {
  const accounts = listAccounts().filter((account) => account.active);
  const counterparties = {};
  for (const party of understanding.counterparties || []) {
    const { exact, similar } = matchCounterparty(db, party.name);
    const canonical = canonicalCounterpartyName(party.name);
    // گزینه‌های انتخابگر: هم‌نام‌ها و نام‌هایی که ریشهٔ مشترک دارند، نه کل فهرست.
    const candidates = canonical
      ? db.prepare(`SELECT id,name FROM contacts WHERE canonical_name=? OR canonical_name LIKE ? ORDER BY name LIMIT 6`).all(canonical, `%${canonical.split(' ').at(-1)}%`)
      : [];
    counterparties[party.id] = exact
      ? { status: 'exact', contactId: exact.id, name: exact.name, candidates: [exact], balance: counterpartyLedgerBalance(exact) }
      : similar
        ? { status: 'similar', contactId: null, name: party.name, candidates: [similar, ...candidates.filter((item) => item.id !== similar.id)].slice(0, 6), balance: null }
        : { status: 'new', contactId: null, name: party.name, candidates, balance: null };
  }

  const endpoints = {};
  for (const movement of understanding.movements || []) {
    for (const side of ['from', 'to']) {
      const endpoint = movement[side];
      endpoints[`${movement.id}.${side}`] = resolveEndpoint(endpoint, accounts);
    }
  }
  return {
    counterparties, endpoints,
    accounts: accounts.map((account) => ({ id: account.id, name: account.name, kind: account.kind })),
    topicHistory: topicHistory(understanding.subject?.what),
  };
}

/**
 * همان قلم در همین دفتر قبلاً با چه دسته‌ای ثبت شد؟
 *
 * «آب معدنی دفتر»، «آب معدنی برای دفتر» و «دو کارتن آب معدنی» در یک روز سه دستهٔ
 * مختلف گرفتند، چون هر بار از نو تصمیم گرفته می‌شد (آزمون زندهٔ ۴ آبان ۱۴۰۵). حسابدار
 * یک قلم را یک بار طبقه‌بندی می‌کند و بعد همان را تکرار می‌کند. فقط ثبت‌های قطعی
 * (نه منتظرِ حسابدار) و فقط دو ثبتِ آخر: اگر هم‌دسته‌اند، `agreed` همان دسته است.
 */
function topicHistory(label) {
  const { item } = topicParts(label);
  if (!item) return null;
  const key = topicLabelKey(item);
  const recent = db.prepare(`SELECT type,category,topic_label AS topicLabel FROM transactions
    WHERE status!='deleted' AND journal_deferred=0 AND topic_label!='' ORDER BY created_at DESC,rowid DESC LIMIT 500`).all()
    .filter((row) => topicLabelKey(topicParts(row.topicLabel).item) === key).slice(0, 2)
    .map((row) => ({ type: row.type, category: row.category }));
  if (!recent.length) return null;
  const agreed = recent.length === 2 && recent[0].type === recent[1].type && recent[0].category === recent[1].category ? recent[0] : null;
  return { item, recent, agreed };
}

function resolveEndpoint(endpoint, accounts) {
  if (!endpoint) return { status: 'none', accountId: null };
  const operational = accounts.filter((account) => account.kind !== 'petty');
  if (endpoint.kind === 'cash') {
    const cash = operational.filter((account) => account.kind === 'cash');
    const main = cash.find((account) => account.id === 'cash');
    return main || cash.length === 1 ? { status: 'resolved', accountId: (main || cash[0]).id, label: (main || cash[0]).name } : { status: 'ambiguous', accountId: null };
  }
  if (endpoint.kind === 'petty-cash') {
    const fund = pickPettyCashAccount(accounts, { holder: endpoint.name || null });
    return fund ? { status: 'resolved', accountId: fund.id, label: fund.name } : { status: 'ambiguous', accountId: null };
  }
  if (endpoint.kind === 'bank') {
    // مدل خودش گفته این سمت بانک است؛ همان نشانه برای نامِ کوتاهی مثل «سامان» کافی است.
    const bank = endpoint.name ? detectBank(endpoint.name) || detectBank(`بانک ${endpoint.name}`) : null;
    const banks = operational.filter((account) => account.kind === 'bank');
    if (bank) {
      const matches = banks.filter((account) => account.bankId === bank.bankId);
      if (matches.length === 1) return { status: 'resolved', accountId: matches[0].id, label: matches[0].name };
      return { status: matches.length ? 'ambiguous' : 'unknown-bank', accountId: null, bankId: bank.bankId, label: bank.bankName };
    }
    // «از بانک» بی‌نام فقط وقتی روشن است که دفتر یک حساب بانکی بیشتر ندارد.
    return banks.length === 1 && !endpoint.name ? { status: 'resolved', accountId: banks[0].id, label: banks[0].name } : { status: 'ambiguous', accountId: null };
  }
  return { status: 'none', accountId: null };
}
