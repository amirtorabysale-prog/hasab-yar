import { extractAmounts } from './parser.js';
import { normalizePersian } from './normalize.js';

export function conditionalWaiver(text) {
  const t=normalizePersian(text);
  return /می بخشم|می بخشیم|ببخش|بخشود|بخشیده/.test(t) && /دیگه بدی|دیگر بده|اگر|در صورت|مشروط|پس از پرداخت/.test(t);
}

// A promise is not payment and must never discharge the conditional balance.
// Only an explicit, scaled amount followed by a completed payment is extracted.
export function conditionalPaymentProposal(text,facts={}) {
  if(!conditionalWaiver(text)) return null;
  const answers=Object.values(facts.questionAnswers || {}).map(a=>normalizePersian(a.value)).join(' ');
  if(/شرط محقق|شرط انجام|پرداخت شد|پرداخت کردیم/.test(answers) && !/نشده|نشد|فقط تعهد|تعهد پرداخت/.test(answers)) return null;
  const {text:t,spans}=extractAmounts(text);
  const paid=spans.filter((s,i)=>!s.bareScale && !/اگر|در صورت|مشروط/.test(t.slice(Math.max(t.lastIndexOf('،',s.start),t.lastIndexOf('.',s.start))+1,s.start)) && /میلیون|هزار|میلیارد|[0-9]{4}/.test(s.raw) &&
    /^\s*(?:تومان|تومن|ریال)?\s*(?:پرداخت کردیم|پرداخت کردم|دادیم|دادم|واریز کردیم|واریز کردم)(?:\s|،|\.|$)/.test(t.slice(s.end,spans[i+1]?.start)));
  if(paid.length!==1 || /ریال/.test(t.slice(paid[0].end,paid[0].end+8))) return null;
  const amount=paid[0].amount;
  return {summary:'ثبت پرداخت انجام‌شده؛ بخشودگی مشروط هنوز تحقق نیافته',explanation:'فقط وجه پرداخت‌شده از بدهی همان تأمین‌کننده کم می‌شود. تعهد پرداخت بعدی و بخشودگی وابسته به آن، در این سند وجه یا درآمد نیستند؛ مانده تا تحقق شرط باقی می‌ماند.',missingFacts:[],questions:[],lines:[{role:'payable',debit:amount,credit:0},{role:'cash',debit:0,credit:amount}]};
}
