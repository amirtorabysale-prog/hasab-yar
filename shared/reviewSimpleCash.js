import { normalizePersian } from './normalize.js';
import { reviewNature } from './reviewNature.js';

/** Narrow, explicit cash facts; approval still checks person, balance and real accounts. */
export function simpleReviewCashProposal(text,amount,{advanceRole='customer-advance'}={}) {
  if(!Number.isSafeInteger(amount) || amount<=0) return null;
  const t=normalizePersian(text),nature=reviewNature(t);
  if(/پرداخت نکرد|دریافت نکرد|پرداخت نشده|دریافت نشده|هنوز.*پرداخت نشده/.test(t)) return null;
  const result=(summary,explanation,role,outgoing)=>({summary,explanation,questions:[],missingFacts:[],inventoryItems:[],lines:[
    {role,debit:outgoing?amount:0,credit:outgoing?0:amount},
    {role:'cash',debit:outgoing?0:amount,credit:outgoing?amount:0},
  ]});
  // نقش بدهی همانی است که دریافت اولیه ساخت (پیش‌دریافت یا درآمد انتقالی)؛ فراخواننده از دفتر می‌خواند.
  if(nature.advanceRefund && nature.refund) return result('عودت پیش‌دریافت مشتری','کاهش پیش‌دریافت همان مشتری و خروج وجه؛ اعمال فقط با مانده واقعی و تأیید حسابدار انجام می‌شود.',advanceRole==='deferred-revenue'?'deferred-revenue':'customer-advance',true);
  if(nature.advance && !nature.advanceRefund && /دریافت کرد|دریافت شد|واریز شد/.test(t)) return result('دریافت پیش‌دریافت خدمت انجام‌نشده','وجه وارد شده ولی تعهد هنوز انجام نشده است؛ پیش‌دریافت شناسایی می‌شود و درآمد ساخته نمی‌شود.','customer-advance',false);
  if(nature.deposit && /پرداخت کرد|پرداخت شد/.test(t) && !nature.refund && !/برگشت.*دریافت/.test(t)) return result('پرداخت سپرده قابل استرداد','وجه پرداخت‌شده قابل استرداد است؛ ودیعه دارایی است و هزینه جاری شناسایی نمی‌شود.','refundable-deposit',true);
  return null;
}
