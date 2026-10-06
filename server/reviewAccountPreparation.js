import { inventoryLedgerAccount } from './accounting.js';
import { createHash } from 'node:crypto';
import { listChartAccounts, mapLedgerAccountToChart, suggestChartAccount } from './chartOfAccounts.js';
import { resolveEventRole } from './roleResolver.js';
import { normalizePersian } from '../shared/normalize.js';

export const REVIEW_ACCOUNT_TYPES = Object.freeze({
  'tax-receivable':'asset','payroll-insurance-payable':'liability',
  'partner-payable':'liability','partner-receivable':'asset',
  'unidentified-receipt':'liability',
  'inventory-asset':'asset',cash:'asset',receivable:'asset',payable:'liability','cheque-receivable':'asset','cheque-payable':'liability',
  'expense-category':'expense','income-category':'income','prepaid-asset':'asset','fixed-asset':'asset',
  'refundable-deposit':'asset','loan-payable':'liability','owner-capital':'equity','customer-advance':'liability','deferred-revenue':'liability',
  'accumulated-depreciation':'asset','depreciation-expense':'expense','vat-input':'asset','vat-output':'liability',
});
export const reviewNormalSide = role => role==='accumulated-depreciation' ? 'credit' : ['asset','expense'].includes(REVIEW_ACCOUNT_TYPES[role]) ? 'debit' : 'credit';
const normalize = value => normalizePersian(String(value || '')).replace(/[\s‌ٔ]+/g,' ').trim();
const typed = (account,role) => account.type===REVIEW_ACCOUNT_TYPES[role] && (account.normalSide || account.normal_side)===reviewNormalSide(role);
const namedRoles = new Set(['expense-category','income-category','prepaid-asset','fixed-asset','accumulated-depreciation']);

/** Select actual ledgers, or preview a linked ledger under an existing subsidiary. Never mutate during analysis. */
export function prepareReviewAccount(database,line,event,{resolve=false}={}) {
  const blockers=[], role=line.role, key=String(line.key || '').trim();
  const chart=listChartAccounts(database);
  let account=line.accountId ? database.prepare('SELECT *,normal_side AS normalSide FROM ledger_accounts WHERE id=? AND active=1').get(line.accountId) : null;
  if(role==='payroll-insurance-payable') return {account,creation:null,blockers:account && typed(account,role) && account.source_kind==='payroll-insurance-payable'?[]:['پرداخت بیمه به حساب بیمهٔ پرداختنی لیست حقوق نیاز دارد؛ ایجاد حساب فرضی مجاز نیست.']};
  if(role==='tax-receivable') return {account,creation:null,blockers:account && typed(account,role)?[]:['وصول طلب مالیاتی به حساب واقعی سند مبنا نیاز دارد؛ ایجاد حساب فرضی مجاز نیست.']};
  if(role==='inventory-asset') {
    const item=(event.reviewInventoryItems || []).find(i=>normalize(i.name)===normalize(key));
    if(item?.productId) {
      const linked=database.prepare("SELECT *,normal_side AS normalSide FROM ledger_accounts WHERE source_kind='inventory-product' AND source_key=? AND active=1").get(item.productId);
      if(account && (account.source_kind!=='inventory-product' || account.source_key!==item.productId)) blockers.push('حساب موجودی باید به همان کالای ورود انبار متصل باشد.');
      account=account || linked;
    }
    if(resolve && item?.productId && !account) {const id=inventoryLedgerAccount(database,{id:item.productId,name:item.name});account=database.prepare('SELECT *,normal_side AS normalSide FROM ledger_accounts WHERE id=?').get(id);}
    if(line.chartAccountId) {const selected=chart.find(c=>c.id===line.chartAccountId);if(!selected || !selected.active || !selected.postable || selected.type!=='asset' || selected.normalSide!=='debit' || selected.role!=='inventory') blockers.push('معین موجودی پیشنهادی باید معین فعال موجودی کالا باشد.');else if(resolve && account) mapLedgerAccountToChart(database,account.id,selected.id);}
    if(account && (!account.active || !typed(account,role))) blockers.push('حساب موجودی فعال یا هم‌ماهیت نیست.');
    if(!item) blockers.push('اطلاعات کالای این سطر برای ورود انبار کامل نیست.');
    return {account,creation:account?null:{name:`موجودی کالا — ${key}`,type:'asset',normalSide:'debit',reason:'حساب مرتبط با کالا همراه سند ساخته می‌شود.'},blockers};
  }
  if(line.accountId && !account) blockers.push('حساب پیشنهادی دیگر فعال نیست؛ بازبینی لازم است.');
  if(account && !typed(account,role)) blockers.push('ماهیت حساب واقعی با نقش پیشنهادی سازگار نیست؛ پیشنهاد باید اصلاح شود.');
  const mapping=line.chartAccountId ? chart.find(c=>c.id===line.chartAccountId && c.postable && typed(c,role)) : null;
  if(line.chartAccountId && !mapping) blockers.push('معین پیشنهادی معتبر یا هم‌ماهیت نیست؛ پیشنهاد باید اصلاح شود.');
  if(['expense-category','income-category'].includes(role) && key) {
    const expected=suggestChartAccount({name:key,type:REVIEW_ACCOUNT_TYPES[role],sourceKind:role,sourceKey:key},chart,{confidentOnly:true});
    if(expected && ((mapping && mapping.id!==expected.id) || (account?.chart_account_id && account.chart_account_id!==expected.id))) blockers.push(`معین حساب با دستهٔ «${key}» سازگار نیست؛ معین مرتبط «${expected.name}» است.`);
  }
  if(account && mapping && account.chart_account_id!==mapping.id) blockers.push('حساب و معین پیشنهادی با هم تطبیق ندارند.');
  if(!account && !line.accountId && namedRoles.has(role) && key) {
    const matches=database.prepare('SELECT *,normal_side AS normalSide FROM ledger_accounts WHERE active=1 AND type=? AND normal_side=?').all(REVIEW_ACCOUNT_TYPES[role],reviewNormalSide(role))
      .filter(a=>normalize(a.name)===normalize(key) && (!mapping || a.chart_account_id===mapping.id));
    if(matches.length===1) account=matches[0];
    else if(matches.length>1) blockers.push('چند حساب هم‌نام پیدا شد؛ AI باید با کدینگ و سابقه حساب دقیق را مشخص کند.');
  }
  const suggested=mapping || (key && namedRoles.has(role) ? suggestChartAccount({type:REVIEW_ACCOUNT_TYPES[role],name:key,sourceKind:role,sourceKey:key},chart,{confidentOnly:true}) : null);
  if(role==='prepaid-asset' && suggested && !/پیش[‌\s]*پرداخت/.test(suggested.name)) blockers.push('معین پیش‌پرداخت باید مخصوص پیش‌پرداخت باشد؛ انتخاب دارایی نامرتبط مجاز نیست.');
  if(!account && suggested && namedRoles.has(role)) {
    const matches=database.prepare("SELECT *,normal_side AS normalSide FROM ledger_accounts WHERE chart_account_id=? AND active=1 AND source_kind='chart-account'").all(suggested.id).filter(a=>typed(a,role));
    if(matches.length===1) account=matches[0];
  }
  // Party ledgers must retain identity links; a generic subsidiary cannot replace them.
  const creation=!account && !blockers.length && key ? {name:key,type:REVIEW_ACCOUNT_TYPES[role],normalSide:reviewNormalSide(role),chartAccountId:suggested?.id || null,chartCode:suggested?.code || '',chartName:suggested?.name || '',reason:'حساب مرتبط موجود نیست؛ با تأیید سند ساخته می‌شود.'} : null;
  if(resolve && !account && !blockers.length) {
    const id=resolveEventRole(database,role,key,event);
    if(suggested) mapLedgerAccountToChart(database,id,suggested.id);
    account=database.prepare('SELECT *,normal_side AS normalSide FROM ledger_accounts WHERE id=?').get(id);
    if(!account?.active || !typed(account,role)) blockers.push('حساب ساخته‌شده با ماهیت پیشنهاد سازگار نیست.');
  }
  return {account,creation,blockers};
}

/** Full catalog, compact tuples; no first-300 truncation that hides relevant accounts. */
export function reviewAccountCatalog(database) {
  const ledger=database.prepare('SELECT id,code,name,type,normal_side,source_kind,source_key,chart_account_id FROM ledger_accounts WHERE active=1 ORDER BY code').all();
  return {
    operationalAccounts: database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get()
      ? database.prepare('SELECT id,name,kind,bank_id AS bankId FROM accounts WHERE active=1 ORDER BY id').all() : [],
    ledgerFields:['id','code','name','type','normalSide','sourceKind','sourceKey','chartAccountId'],
    ledger:ledger.map(a=>[a.id,a.code,a.name,a.type,a.normal_side,a.source_kind,a.source_key,a.chart_account_id]),
    chartFields:['id','code','name','type','normalSide','role','requiresAnalytic'],
    chart:listChartAccounts(database).filter(a=>a.postable).map(a=>[a.id,a.code,a.name,a.type,a.normalSide,a.role,a.requiresAnalytic]),
  };
}

// A cached suggestion is invalid when the chart, identity, bank or ledger changes.
export function reviewKnowledgeFingerprint(database) {
  const identity = table => database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return createHash('sha256').update(JSON.stringify(['review-structured-output-v8-tax-refund',
    reviewAccountCatalog(database),
    identity('accounting_review_tax_refunds') ? database.prepare('SELECT * FROM accounting_review_tax_refunds ORDER BY event_id').all() : [],
    identity('payroll_runs') ? database.prepare('SELECT id,insurance_paid_at FROM payroll_runs ORDER BY id').all() : [],
    identity('contacts') ? database.prepare('SELECT id,name FROM contacts ORDER BY id').all() : [],
    identity('accounts') ? database.prepare('SELECT id,name,active,kind,bank_id FROM accounts ORDER BY id').all() : [],
    database.prepare('SELECT count(*) n,MAX(rowid) last FROM journal_entries').get(),
    database.prepare('SELECT count(*) n,MAX(rowid) last FROM journal_lines').get(),
    identity('accounting_review_ai') ? database.prepare("SELECT id,state,feedback_reason,reviewed_at FROM accounting_review_ai WHERE state!='proposed' ORDER BY id").all() : [],
    identity('products') ? database.prepare('SELECT id,name,unit,stock,average_cost,inventory_value,track_inventory FROM products ORDER BY id').all() : [],
    database.prepare("SELECT count(*) n,MAX(rowid) last FROM financial_event_audit WHERE stage IN ('approved','accountant-reviewed','rejected')").get(),
  ])).digest('hex');
}
