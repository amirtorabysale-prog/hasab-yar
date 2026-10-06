import { reviewNature } from '../shared/reviewNature.js';
import { postJournalEntry, taxReceivableLedgerAccount, vatRefundClaimable } from './accounting.js';
import { resolveEventRole, resolveEventAnalytic } from './roleResolver.js';

const fail=(message,code='REVIEW_BASIS_INVALID',status=409)=>Object.assign(new Error(message),{code,status});
/** Missing imported balances are never inferred from the AI's proposal. */
export function reviewPriorBasis(database,row,event,lines=[]) {
  if(row.status!=='pending' || database.prepare("SELECT 1 FROM journal_entries WHERE source_type='review-prior-basis' AND source_id=?").get(row.id)) return null;
  const tax=reviewNature(event.evidence || '').vatRefund;
  const trade=lines.find(l=>['payable','receivable'].includes(l.role));
  const cash=lines.find(l=>l.role==='cash');
  const role=tax?'tax-receivable':trade && cash && lines.length===2?trade.role:null;
  if(!role || (!tax && !event.counterpartyId)) return null;
  if(!tax && (role==='payable' ? !(trade.debit>0 && cash.credit===trade.debit) : !(trade.credit>0 && cash.debit===trade.credit))) return null;
  const source=tax?'tax-receivable':role==='payable'?'vendor-payable':'customer-receivable';
  const prior=database.prepare('SELECT 1 FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE a.source_kind=? AND (? OR a.source_key=?) LIMIT 1').get(source,tax?1:0,event.counterpartyId || '');
  if(prior || (tax && vatRefundClaimable(database).total>0)) return null;
  return {role,amount:tax?row.amount:cash.debit || cash.credit,counterpartyName:event.counterparty || null,
    counterpartyId:event.counterpartyId || null,latestDate:String(event.occurredAt || '').slice(0,10),
    debit:role==='payable'?'سرمایه افتتاحیه':tax?'مطالبات استرداد ارزش افزوده':`طلب از ${event.counterparty}`,
    credit:role==='payable'?`بدهی به ${event.counterparty}`:'سرمایه افتتاحیه'};
}

/** Caller owns an atomic transaction and has checked manager permission. */
export function postReviewPriorBasis(database,row,event,lines,input,{actor,timeZone}={}) {
  const basis=reviewPriorBasis(database,row,event,lines);
  if(!basis) throw fail('این پرونده مانده منتقل‌شده قابل ثبت ندارد؛ سند مبنای موجود را بررسی کن.');
  const amount=Number(input.amount),date=String(input.occurredAt || ''),reference=String(input.reference || '').trim();
  if(input.confirmed!==true || !Number.isSafeInteger(amount) || amount<basis.amount || amount<=0 || reference.length<8 || reference.length>300) throw fail('مبلغ واقعی، مرجع مستند و تأیید صریح مانده منتقل‌شده لازم است.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date>=basis.latestDate) throw fail('تاریخ مانده منتقل‌شده باید معتبر و قبل از تاریخ پرداخت یا وصول باشد.');
  const accountId=basis.role==='tax-receivable'?taxReceivableLedgerAccount(database):resolveEventRole(database,basis.role,event.counterparty,event);
  const equity=database.prepare("SELECT id FROM ledger_accounts WHERE source_kind='system' AND source_key='opening-equity' AND active=1").get();
  if(!equity) throw fail('حساب سرمایه افتتاحیه فعال نیست.');
  const payable=basis.role==='payable',analyticId=payable || basis.role==='receivable'?resolveEventAnalytic(database,basis.role,event):null;
  return postJournalEntry(database,{sourceType:'review-prior-basis',sourceId:row.id,occurredAt:date,
    memo:`مانده منتقل‌شده تأییدشده — ${basis.role==='tax-receivable'?'طلب استرداد ارزش افزوده':event.counterparty} — ${reference}`,
    lines:[{accountId,analyticId,debit:payable?0:amount,credit:payable?amount:0,description:reference},{accountId:equity.id,debit:payable?amount:0,credit:payable?0:amount}]},{createdBy:actor,timeZone});
}
