/** Stable business-question identities shared by server and UI; old proposals remain readable. */
const normalize = text => String(text).replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function businessFact(text) {
  const t=normalize(text);
  if(/بانک|صندوق|حساب عملیاتی/.test(t) && /کدام|مشخص نیست|انتخاب/.test(t) && !/طرف حساب|طلب|بدهی|سند مبنا/.test(t)) return 'cash-account';
  if(/هزینه/.test(t) && /بابت|ماهیت|نوع/.test(t) && !/دارایی|پیش پرداخت|عمر|حساب|سرفصل|بانک|صندوق/.test(t)) return 'expense-purpose';
  if(/پوشش|شروع خدمت|دوره خدمت/.test(t) && /شروع|آبان|سال/.test(t) && !/پایان|اتمام|انتها/.test(t)) return 'coverage-start';
  if(/نام/.test(t) && /طرف حساب|شخص|شرکت|تامین کننده|تأمین کننده/.test(t)) return 'counterparty-name';
  if(/مبلغ|چقدر/.test(t) && /بخشودگی|بخشیده/.test(t)) return 'waiver-amount';
  if(/پرداخت شده|پرداخت شد/.test(t) && /تعهد|همین رویداد/.test(t)) return 'payment-performed';
  if(/واحد/.test(t) && /کالا|ثبت/.test(t)) return 'inventory-unit';
  if(/چند|تعداد|مقدار/.test(t) && /کالا|تحویل|خرید/.test(t)) return 'inventory-quantity';
  if(/عمر/.test(t) && /استفاده|انتظار|چاپگر|مفید/.test(t)) return 'useful-life';
  if(/دارایی ثابت/.test(t) && /هزینه|مصرفی|کالای/.test(t)) return 'capitalization-choice';
  if(/سیاست/.test(t) && /سرمایه/.test(t)) return 'capitalization-policy';
  return null;
}
const stableFacts=new Set(['cash-account','expense-purpose','counterparty-name','waiver-amount','payment-performed','capitalization-choice']);
function legacyId(text) {
  let hash=2166136261;
  for(const char of normalize(text)) hash=Math.imul(hash ^ char.codePointAt(0),16777619);
  return `question-${(hash>>>0).toString(16)}`;
}
export function reviewQuestions(proposal={}) {
  const result=[];
  const add=(text,id,field)=>{
    if(typeof text!=='string' || !text.trim()) return;
    text=text.trim().slice(0,150);
    id=typeof id==='string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(id)?id:legacyId(text);
    const fact=businessFact(text);
    if(fact==='cash-account' || field==='accountId') { id='cash.account';field='accountId'; }
    else if(stableFacts.has(fact)) id=`fact.${fact}`;
    if(fact==='counterparty-name' && !field) field='counterpartyName';
    // Coverage is a contract fact, never the cash occurrence date. Keep the
    // answer in the conversation without overwriting the transaction date.
    if(field==='occurredAt' && /coverage|service[_.-]?(?:start|end)|پوشش|شروع خدمت|دوره خدمت/.test(`${id} ${text}`)) field=null;
    if(!result.some(q=>q.id===id || normalize(q.text)===normalize(text) || (businessFact(text) && businessFact(q.text)===businessFact(text)))) result.push({id,text,...(['occurredAt','dueAt','counterpartyName','counterpartyId','accountId'].includes(field)?{field}:{})});
  };
  for(const q of (Array.isArray(proposal.questions)?proposal.questions:[]).slice(0,5)) add(q?.text,q?.id,q?.field);
  for(const text of (Array.isArray(proposal.missingFacts)?proposal.missingFacts:[]).slice(0,5)) add(text);
  return result.slice(0,5);
}

/** Keep old answered questions readable when the model changes IDs or wording. */
export function reviewSavedAnswers(answers={}) {
  const result={};
  for(const [id,answer] of Object.entries(answers)) {
    const fact=businessFact(answer.question || '');
    result[fact==='cash-account' || answer.field==='accountId'?'cash.account':stableFacts.has(fact)?`fact.${fact}`:id]=answer;
  }
  return result;
}

// Creation of supported ledgers is the application's job, not a fact to ask
// the accountant. Actual bank, identity, prior balance and ambiguous mapping
// questions must remain. Final account validation still gates posting.
export function isReviewAccountSetupQuestion(q) {
  const t=normalize(q.text || q);
  return /حساب|سرفصل|معین/.test(t) && /ایجاد|ساخت|تطبیق/.test(t) && /موجود نیست|وجود ندارد/.test(t) &&
    !/بانک|صندوق|مانده|سند مبنا|کدام|انتخاب|بدهی|طلب/.test(t);
}
