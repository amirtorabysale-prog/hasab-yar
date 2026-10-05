import { suggestChartAccount } from './chartOfAccounts.js';
import { REVIEW_ACCOUNT_TYPES, reviewNormalSide } from './reviewAccountPreparation.js';
const sources={cash:'operational-account',receivable:'customer-receivable',payable:'vendor-payable','inventory-asset':'inventory-product'};
const identityRoles=new Set(['partner-payable','partner-receivable','unidentified-receipt','cash','receivable','payable','cheque-receivable','cheque-payable','customer-advance','deferred-revenue','refundable-deposit','loan-payable','inventory-asset']);
/** Correct only catalog bindings, never amounts, dates, accounting roles or business facts. */
export function bindReviewProposal(proposal,catalog,event) {
  const corrections=[];
  const charts=catalog.chart.map(a=>({id:a[0],code:a[1],name:a[2],type:a[3],normalSide:a[4],role:a[5],level:'subsidiary',postable:true,active:true}));
  const lines=proposal.lines.map(original=>{
    const line={...original}, role=line.role;
    const account=catalog.ledger.find(a=>a[0]===line.accountId);
    const chart=catalog.chart.find(a=>a[0]===line.chartAccountId);
    const type=REVIEW_ACCOUNT_TYPES[role], side=reviewNormalSide(role);
    if(['expense-category','income-category'].includes(role) && line.key) {
      const expected=suggestChartAccount({name:line.key,type,sourceKind:role,sourceKey:line.key},charts,{confidentOnly:true});
      if(expected && ((chart && chart[0]!==expected.id) || (account && account[7]!==expected.id))) {
        delete line.accountId; line.chartAccountId=expected.id;
        corrections.push(`نگاشت دستهٔ «${line.key}» به معین «${expected.name}» اصلاح شد؛ مبلغ و ماهیت تغییر نکرد.`);
      }
    }
    if(identityRoles.has(role) && account && (account[3]!==type || account[4]!==side || account[5]!== (sources[role] || role))) {
      delete line.accountId; corrections.push(`حساب ناسازگار سطر ${role} از پیشنهاد حذف شد؛ حساب مرتبط هنگام تأیید تعیین می‌شود.`);
    }
    if(role==='cash' && account && account[6]!==event.accountId) delete line.accountId;
    if(chart && (chart[3]!==type || chart[4]!==side || (role==='inventory-asset' && chart[5]!=='inventory'))) delete line.chartAccountId;
    // Identity-bearing ledgers are resolved from the actual bank, person or product.
    if(identityRoles.has(role)) {delete line.accountId;delete line.chartAccountId;}
    else if(line.accountId && line.chartAccountId && account?.[7]!==line.chartAccountId) {
      // Retain the requested subsidiary and select/create its ledger instead of remapping history.
      delete line.accountId;
      corrections.push('حساب و معین متناقض بود؛ حساب متناظر معین انتخاب‌شده تعیین می‌شود.');
    }
    return line;
  });
  const inv=lines.filter(l=>l.role==='inventory-asset');
  if(inv.length===1 && proposal.inventoryItems.length===1 && inv[0].debit===proposal.inventoryItems[0].total) inv[0].key=proposal.inventoryItems[0].name;
  return {...proposal,lines,bindingCorrections:corrections};
}
