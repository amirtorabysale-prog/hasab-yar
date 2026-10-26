import { reviewNature } from '../shared/reviewNature.js';
import { normalizePersian } from '../shared/normalize.js';
import { vatRefundClaimable } from './accounting.js';
import { unitLabel } from '../shared/amountUnit.js';

export function ensureTaxRefundSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS accounting_review_tax_refunds (
    event_id TEXT PRIMARY KEY REFERENCES financial_events(id) ON DELETE RESTRICT,
    claim_line_id TEXT NOT NULL REFERENCES journal_lines(id) ON DELETE RESTRICT,
    refund_journal_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    amount INTEGER NOT NULL CHECK(amount>0));
    CREATE INDEX IF NOT EXISTS idx_review_tax_refund_claim ON accounting_review_tax_refunds(claim_line_id);`);
}
const question = text => ({id:'nature.vat-refund',text});
const reference = value => normalizePersian(String(value || '')).trim();

// A purchase input-tax credit is not an approved tax refund receivable. Only a
// deliberately classified tax receivable ledger with an actual posted debit is eligible.
export function taxRefundContext(database,text,amount,event={}) {
  if(!reviewNature(text).vatRefund) return null;
  ensureTaxRefundSchema(database);
  const claims=database.prepare(`SELECT l.id AS lineId,(SELECT count(*) FROM journal_lines s WHERE s.entry_id=l.entry_id AND s.rowid<=l.rowid) AS lineNumber,l.account_id AS accountId,l.debit,j.id AS journalId,
    j.document_number AS documentNumber,j.fiscal_year AS fiscalYear,j.occurred_at AS occurredAt,
    j.memo,a.name AS accountName FROM journal_lines l
    JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id
    LEFT JOIN chart_accounts c ON c.id=a.chart_account_id
    WHERE l.debit>0 AND a.active=1 AND a.type='asset' AND a.normal_side='debit'
      AND (a.source_kind='tax-receivable' OR c.role='tax-receivable')
      AND j.entry_kind!='reversal' AND j.approval_state='approved'
      AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)
    ORDER BY j.occurred_at,j.document_number,l.id`).all().filter(c=>event.occurredAt && c.occurredAt<=event.occurredAt);
  for(const c of claims) {
    const allocated=database.prepare(`SELECT COALESCE(SUM(r.amount),0) n FROM accounting_review_tax_refunds r
      JOIN financial_events e ON e.id=r.event_id WHERE r.claim_line_id=? AND e.status='posted'
      AND NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.reverses_entry_id=r.refund_journal_id)`).get(c.lineId).n;
    // محافظه‌کارانه: بدهکارِ پیش‌نویس هنوز طلبی نساخته، ولی بستانکارِ
    // پیش‌نویس شاید فردا تأیید شود و همین طلب را ببندد.
    const balance=database.prepare(`SELECT COALESCE(SUM(CASE WHEN j.approval_state='approved' THEN l.debit ELSE 0 END-l.credit),0) n FROM journal_lines l
      JOIN journal_entries j ON j.id=l.entry_id WHERE l.account_id=? AND j.occurred_at<=?`).get(c.accountId,event.occurredAt).n;
    // Old unallocated credits cannot be silently assigned to an arbitrary claim.
    const unlinked=database.prepare(`SELECT count(*) n FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
      WHERE l.account_id=? AND l.credit>0 AND j.entry_kind!='reversal'
      AND NOT EXISTS(SELECT 1 FROM journal_entries rev WHERE rev.reverses_entry_id=j.id)
      AND NOT EXISTS(SELECT 1 FROM accounting_review_tax_refunds r WHERE r.refund_journal_id=j.id)`).get(c.accountId).n;
    c.available=Math.min(c.debit-allocated,balance);
    c.unlinked=unlinked>0;
    c.reference=`${c.fiscalYear}/${c.documentNumber}${claims.filter(other=>other.journalId===c.journalId).length>1?`/${c.lineNumber}`:''}`;
  }
  const answer=reference(event.questionAnswers?.['nature.vat-refund']?.value);
  const requestedScope=/ارزش افزوده/.test(reference(text))?'vat':/مالیات عملکرد|مالیات درآمد/.test(reference(text))?'income':null;
  const scope=c=>/ارزش افزوده/.test(reference(c.accountName+' '+c.memo))?'vat':/مالیات عملکرد|مالیات درآمد/.test(reference(c.accountName+' '+c.memo))?'income':null;
  const available=claims.filter(c=>c.available>0 && (!requestedScope || scope(c)===requestedScope));
  const matched=answer ? claims.filter(c=>[c.reference,String(c.documentNumber),c.journalId,c.lineId].some(v=>reference(v)===answer)) : available;
  if(matched.length!==1) {
    const candidates=claims.filter(c=>c.available>0 && (!requestedScope || !scope(c) || scope(c)===requestedScope)).slice(0,20);
    // نبودِ سند طلب، بن‌بست نیست وقتی دفتر اعتبار یا اضافه‌پرداخت قابل استرداد
    // دارد: راهش ثبت «طلب استرداد» در صفحهٔ مالیات است، نه درآمد تازه.
    const claimable=candidates.length ? 0 : vatRefundClaimable(database).total;
    return {claim:null,candidates,question:question(candidates.length ? 'استرداد مربوط به کدام سند طلب مالیاتی است؟ شماره سال/سند را از پیشنهادهای زیر انتخاب یا وارد کن.'
      : claimable>0 ? `سند طلب استرداد ثبت نشده، ولی دفتر ${claimable.toLocaleString('fa-IR')} ${unitLabel()} اعتبار یا اضافه‌پرداخت ارزش افزوده دارد. در صفحهٔ «مالیات» دکمهٔ «ثبت طلب استرداد» را با شمارهٔ اظهارنامه بزن، سپس شمارهٔ سال/سند همان طلب را اینجا وارد کن.`
        : 'سند طلب مالیاتی مرتبط پیدا نشد؛ سند واقعی طلب را ثبت یا نگاشت کن و شماره سال/سند آن را وارد کن.')};
  }
  const claim=matched[0];
  if(requestedScope && scope(claim) && scope(claim)!==requestedScope) return {claim:null,question:question('نوع مالیات سند مبنا با استرداد بیان‌شده سازگار نیست؛ سند مالیات مربوط را انتخاب کن.')};
  // وصولِ قدیمیِ بدون اتصال، انتخاب خودکار را متوقف می‌کند — شاید همین سند را
  // بسته باشد. ولی بن‌بست نیست: وقتی حسابدار شمارهٔ سند را صریح می‌دهد، آن
  // تصمیم مال اوست، و مبلغ همچنان به ماندهٔ واقعی حساب محدود است.
  if(claim.unlinked && !answer) return {claim:null,candidates:[claim],question:question(`این حساب وصولی دارد که به سند مبنا وصل نشده؛ شاید سند ${claim.reference} را بسته باشد. اگر مطمئنی این سند هنوز وصول نشده، شمارهٔ ${claim.reference} را صریح وارد کن.`)};
  if(!Number.isSafeInteger(amount) || amount<=0 || claim.available<amount) return {claim:null,question:question('مبلغ استرداد از مانده واقعی سند طلب مالیاتی بیشتر است؛ سند مبنا یا تفکیک مبلغ را بررسی کن.')};
  return {claim,question:null};
}
export function taxRefundProposal(database,text,amount,event) {
  const context=taxRefundContext(database,text,amount,event);
  if(!context) return null;
  if(!context.claim) return {summary:'تطبیق استرداد با طلب مالیاتی',explanation:'استرداد مالیات درآمد تازه نیست و بدون سند طلب واقعی ثبت نمی‌شود.',missingFacts:[],questions:[context.question],taxRefundCandidates:context.candidates || [],lines:[]};
  const c=context.claim;
  return {summary:'وصول طلب مالیاتی',explanation:`وصول ${amount} ${unitLabel()} بابت سند ${c.reference} — ${c.memo}؛ مانده پیش از وصول ${c.available} ${unitLabel()}. درآمد تازه شناسایی نمی‌شود.`,missingFacts:[],questions:[],lines:[{role:'cash',debit:amount,credit:0},{role:'tax-receivable',accountId:c.accountId,key:c.accountName,debit:0,credit:amount}]};
}
export function taxRefundValidation(database,text,amount,event,lines) {
  const context=taxRefundContext(database,text,amount,event);
  if(!context) return {claim:null,issues:lines.some(l=>l.role==='tax-receivable') ? [question('نقش وصول طلب مالیاتی فقط برای رویداد استرداد مالیات قابل استفاده است.')] : []};
  if(!context.claim) return {claim:null,candidates:context.candidates || [],issues:[context.question]};
  const cash=lines.filter(l=>l.role==='cash'), tax=lines.filter(l=>l.role==='tax-receivable');
  const valid=lines.length===2 && cash.length===1 && tax.length===1 && cash[0].debit===amount && !cash[0].credit && tax[0].credit===amount && !tax[0].debit && tax[0].accountId===context.claim.accountId;
  return {claim:context.claim,issues:valid?[]:[question('پیشنهاد باید بانک را بدهکار و همان حساب طلبِ سند مبنا را بستانکار کند؛ ایجاد طلب یا درآمد تازه مجاز نیست.')]};
}
export function allocateTaxRefund(database,eventId,journalId,claim,amount) {
  if(!claim) return;
  database.prepare('INSERT INTO accounting_review_tax_refunds(event_id,claim_line_id,refund_journal_id,amount) VALUES(?,?,?,?)').run(eventId,claim.lineId,journalId,amount);
}
