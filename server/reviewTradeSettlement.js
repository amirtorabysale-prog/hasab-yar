import { reviewNature } from '../shared/reviewNature.js';
import { normalizePersian } from '../shared/normalize.js';

/** Explicit collection of an existing commercial debt has no new revenue. */
export function tradeCollectionProposal(text,amount,event={}) {
  const n=reviewNature(text),t=normalizePersian(text);
  if(event.amountReferenceOnly || !Number.isSafeInteger(amount) || amount<=0 || !n.settlement || n.partner || n.vatRefund ||
    !/بدهی|طلب/.test(t) || !/به حساب.*شرکت.*واریز کرد|طلب.*وصول شد/.test(t)) return null;
  return {summary:'وصول طلب تجاری قبلی',explanation:'ورود وجه، طلب همان مشتری را کاهش می‌دهد؛ درآمد تازه و حساب جاری شریک ساخته نمی‌شود. سند فقط پس از کنترل مانده واقعی دفتر قابل تأیید است.',missingFacts:[],questions:[],lines:[{role:'cash',debit:amount,credit:0},{role:'receivable',debit:0,credit:amount}]};
}

/** Trade collections/payments need an existing ledger balance, not an AI-created debt. */
export function tradeSettlementValidation(database,event,lines=[]) {
  const cash=lines.filter(l=>l.role==='cash'),trade=lines.filter(l=>['payable','receivable'].includes(l.role));
  const issues=[];
  if(!cash.length || !trade.length) return {issues,settlement:null};
  const add=(text,action=true)=>issues.push({id:'settlement.source',text,action});
  if(cash.length!==1 || trade.length!==1 || lines.length!==2) {
    add('تسویه چندبخشی باید به سند مبنا و اثر هر بخش متصل شود؛ فعلاً فقط پرداخت یا وصول قطعی دوطرفه از این مسیر قابل اعمال است.');
    return {issues,settlement:null};
  }
  const role=trade[0].role,amount=cash[0].debit || cash[0].credit;
  const sourceKind=role==='payable'?'vendor-payable':'customer-receivable';
  if(!event.counterpartyId) {
    if(event.counterparty) add('نام طرف‌حساب مشخص است، اما سند مبنای بدهی/طلب قبلی او در دفتر موجود نیست؛ ابتدا سند واقعی یا مانده افتتاحیه را ثبت کن، سپس بازتحلیل کن.');
    else add('نام دقیق طرف‌حساب بدهی یا طلب قبلی چیست؟',false);
    return {issues,settlement:null};
  }
  const account=database.prepare('SELECT id,name FROM ledger_accounts WHERE source_kind=? AND source_key=? AND active=1').get(sourceKind,event.counterpartyId);
  const balance=account ? database.prepare('SELECT COALESCE(SUM(debit-credit),0) n FROM journal_lines WHERE account_id=?').get(account.id).n : 0;
  const historical=account ? database.prepare('SELECT COALESCE(SUM(l.debit-l.credit),0) n FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id WHERE l.account_id=? AND substr(j.occurred_at,1,10)<=?').get(account.id,String(event.occurredAt || '').slice(0,10)).n : 0;
  const available=Math.min(role==='payable'?-balance:balance,role==='payable'?-historical:historical);
  if(!account || available<amount) add('سند مبنای بدهی/طلب این طرف‌حساب در دفتر موجود نیست یا مانده آن کافی نیست؛ ابتدا سند واقعی یا مانده افتتاحیه را ثبت یا اصلاح کن، سپس بازتحلیل کن.');
  // Do not leave subsidiary document balances unchanged after a ledger-only payment.
  const exists=t=>database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if(exists('invoices') && database.prepare(`SELECT 1 FROM invoices WHERE contact_id=? AND document_type=? AND status='sent' AND total>COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id=invoices.id),0) LIMIT 1`).get(event.counterpartyId,role==='payable'?'purchase':'sales')) add('این طرف‌حساب فاکتور باز دارد؛ پرداخت را از تسویه همان فاکتور انجام بده تا مانده فاکتور و دفتر کل هم‌زمان اصلاح شوند.');
  if(exists('obligations') && database.prepare("SELECT 1 FROM obligations WHERE contact_id=? AND status='open' AND amount>COALESCE(paid_amount,0) LIMIT 1").get(event.counterpartyId)) add('این طرف‌حساب تعهد باز دارد؛ تسویه باید از همان تعهد انجام شود تا مانده سند مبنا هم اصلاح شود.');
  const basis=account ? database.prepare('SELECT j.id,j.memo,j.occurred_at AS occurredAt FROM journal_entries j JOIN journal_lines l ON l.entry_id=j.id WHERE l.account_id=? ORDER BY j.occurred_at DESC LIMIT 5').all(account.id):[];
  return {issues,settlement:account?{role,accountId:account.id,accountName:account.name,available,amount,basis}:null};
}
