import { taxPenaltyFacts, isTaxPenaltyCategory } from './reviewTaxPenalty.js';
import { conditionalWaiver, conditionalPaymentProposal } from './reviewSettlement.js';
import { normalizePersian } from './normalize.js';

// Recognition and settlement are different events. These constraints do not
// derive dates, counterparties, tax rates or evidence from model output.
export function reviewNature(text) {
  const t=normalizePersian(text).replace(/\s+/g,' ');
  const unknownReceipt=/ناشناس|نامعلوم|نامشخص|بدون مشخصات|معلوم نیس|مشکوک|نمی دانم.*(?:واریز|فرست|بابت)|(?:واریز|فرست).*نمی دانم/.test(t) && /واریز|دریافت|آمده|اومده|نشسته/.test(t);
  const vatRefund=/مالیات|ارزش افزوده/.test(t) && /استرداد|اضافه پرداخت|اضافه واریز/.test(t) && /برگشت|برگرد|عودت|واریز|دریافت|استرداد/.test(t);
  // «برادرم که شریکمه ده میلیون به حساب شرکت ریخت» هم انتقال شریک است؛ با
  // فعل‌های رسمی تنها، رابطهٔ شریک «نامشخص» خوانده می‌شد (آزمون زندهٔ مهر ۱۴۰۵).
  const partner=/شریک|سهامدار|سهام دار/.test(t) && /واریز|انتقال|پرداخت|برداشت|ریخت|کارت به کارت|داد(?![آ-ی])|دادن/.test(t);
  const capital=/افزایش سرمایه|آورده (?:قطعی|سرمایه)|ثبت سرمایه/.test(t) && !/بدون|هنوز|نیست|نشده/.test(t);
  const insuranceSettlement=/بیمه/.test(t) && /حقوق|کارکنان|کارگر|تامین اجتماعی|لیست/.test(t) && /پرداخت|تسویه|واریز/.test(t);
  const prepaid=(/پیش پرداخت/.test(t) || (/بیمه/.test(t) && /یک ساله|یکساله|12 ماه|دوازده ماه/.test(t) && !insuranceSettlement)) && !/استهلاک|شناسایی هزینه|انتقال به هزینه|مصرف پیش پرداخت/.test(t);
  const advance=/پیش دریافت/.test(t) || /(?:خدمات|خدماتی|خدمت).*هنوز.*انجام نشده/.test(t) && /دریافت|واریز/.test(t);
  const deposit=/ودیعه|سپرده/.test(t) && /استرداد|قابل برگشت|پس می/.test(t);
  const intangible=/حق استفاده|حق امتیاز|علامت تجاری/.test(t) && /خرید|پرداخت/.test(t);
  const leasehold=/استیجاری|اجاره ای/.test(t) && /نصب|بهسازی|احداث/.test(t) && /عمر|چند سال|چهار سال/.test(t);
  const advanceRefund=advance && /پس داد|بازپرداخت|عودت/.test(t);
  const writtenOffRecovery=/طلب|مطالبات/.test(t) && /سوخت شده|حذف شده|حذف.*دفاتر|از دفاتر حذف/.test(t) && /دریافت|وصول|برگشت/.test(t);
  const principal=/اصل وام/.test(t);
  const settlement=/تسویه|بدهی قبلی|طلب قبلی|بدهکار بودیم|خرید ماه قبل|فاکتور قبلی/.test(t) && /پرداخت|واریز|وصول|دریافت/.test(t);
  return {unknownReceipt,vatRefund,partner,capital,insuranceSettlement,prepaid,advance,deposit,intangible,leasehold,advanceRefund,writtenOffRecovery,principal,settlement};
}

export function reviewNatureViolations(text, lines=[], facts={}) {
  const fine=taxPenaltyFacts(text);
  const n=reviewNature(text), roles=new Set(lines.map(l=>l.role)), issues=[];
  const [start,end,occurred]=[facts.servicePeriodStart,facts.servicePeriodEnd,facts.occurredAt].map(v=>v?Date.parse(v):NaN);
  const consumed=[start,end,occurred].every(Number.isFinite) && start<=end && end<=occurred;
  const approvedCapital=facts.questionAnswers?.['nature.partner-transfer']?.value==='افزایش سرمایه مصوب';
  const add=(id,message)=>issues.push({id,text:message});
  if(fine.penalty && lines.length && (fine.prior || fine.mixed || !fine.paid)) add('nature.tax-penalty-basis','جریمه ثبت‌شده یا همراه اصل مالیات به سند مبنا و تفکیک مبلغ نیاز دارد؛ هزینه دوباره مجاز نیست.');
  if(fine.penalty && lines.some(l=>l.role==='expense-category' && !isTaxPenaltyCategory(l.key))) add('nature.tax-penalty-category','جریمه مالیاتی را در حساب مستقل جرایم مالیاتی ثبت کن؛ مالیات و عوارض عمومی جای آن نیست.');
  if(n.unknownReceipt && (roles.has('income-category') || !roles.has('unidentified-receipt')) && lines.length) add('nature.unknown-receipt','منشأ وجه معلوم نیست؛ واریز باید در وجوه دریافتی تعیین‌تکلیف‌نشده نگهداری شود، نه درآمد.');
  // جواب صریح ثبت‌کننده («معلوم نیست از کیست») همان شاهدی است که متن باید می‌داد.
  if(!n.unknownReceipt && roles.has('unidentified-receipt') && facts.receiptPurpose!=='unknown') add('nature.receipt-origin','برای استفاده از وجوه تعیین‌تکلیف‌نشده، ابهام واقعی منشأ واریز باید در متن رویداد مشخص باشد.');
  if(n.vatRefund && lines.length && (!roles.has('tax-receivable') || lines.some(l=>!['cash','tax-receivable'].includes(l.role)))) add('nature.vat-refund','استرداد مالیات درآمد یا هزینه تازه نیست؛ طلب مالیاتی قبلی و سند ایجاد آن باید تطبیق داده شود.');
  if(n.partner && /به حساب شرکت/.test(normalizePersian(text)) && lines.some(l=>l.role==='cash' && l.credit>0)) add('nature.partner-direction','متن از ورود وجه به حساب شرکت می‌گوید؛ پیشنهاد خروج وجه با آن سازگار نیست.');
  const partnerRoles=lines.some(l=>['partner-payable','partner-receivable'].includes(l.role));
  // تسویه از پول شخصی شریک: شریک را ثبت‌کننده روی کارت نام برده و تأیید کرده، و
  // سند هیچ سطر نقدی ندارد. کنترل‌های انتقال وجه شریک دربارهٔ پولی است که به
  // حساب شرکت آمده یا از آن رفته، و این‌جا چنین پولی نیست.
  const settledByPartner=(facts.kind==='obligation-settled-by-partner' || facts.fundedBy==='partner') && !lines.some(l=>l.role==='cash');
  if(partnerRoles && !n.partner && !settledByPartner) add('nature.partner-identity','رابطه شریک در متن رویداد مشخص نیست؛ حساب جاری شریک جای حساب تجاری نیست.');
  if(n.partner && lines.length && !settledByPartner) {
    const expected=partnerTransferProposal(text,lines.find(l=>l.role==='cash')?.debit || lines.find(l=>l.role==='cash')?.credit || 1,facts);
    if(!partnerTreatment(text,facts)) add('nature.partner-transfer','نوع انتقال را مشخص کن: وجه در اختیار شرکت، افزایش سرمایه مصوب، بازپرداخت بدهی شرکت، برداشت شخصی یا بازپرداخت طلب شرکت؟');
    else {
      const shape=ls=>ls.map(l=>[l.role,l.debit || 0,l.credit || 0].join(':')).sort().join('|');
      if(expected && shape(lines)!==shape(expected.lines)) add('nature.partner-shape','جهت وجه و حساب جاری شریک با نوع انتقال تأییدشده سازگار نیست؛ پیشنهاد باید اصلاح شود.');
    }
  }
  if(n.partner && !n.capital && !approvedCapital && roles.has('owner-capital')) add('nature.partner-transfer','انتقال شریک به‌تنهایی افزایش سرمایه نیست؛ این وجه قرض شریک، آورده مصوب یا تسویه حساب قبلی است؟');
  if(n.partner && (roles.has('income-category') || roles.has('expense-category'))) add('nature.partner-purpose','انتقال وجه شریک درآمد یا هزینه شرکت نیست؛ بابت قرض، آورده یا تسویه کدام تعهد است؟');
  if(n.insuranceSettlement && roles.has('expense-category')) add('nature.insurance-settlement','پرداخت لیست بیمه با شناسایی هزینه فرق دارد؛ بدهی بیمه قبلاً ثبت شده و سهم کارفرما و کارکنان چقدر است؟');
  if(n.prepaid && !consumed && roles.has('expense-category')) add('nature.prepaid','پرداخت برای منفعت آینده هزینه جاری نیست؛ پیش‌پرداخت و دوره مصرف آن باید جدا ثبت شوند.');
  if(n.advance && roles.has('income-category')) add('nature.advance','پیش‌دریافت قبل از انجام تعهد درآمد نیست؛ تعهد قبلاً انجام شده یا هنوز باقی است؟');
  if(n.deposit && roles.has('expense-category')) add('nature.deposit','ودیعه قابل استرداد هزینه نیست؛ دارایی ودیعه و طرف قرارداد لازم است.');
  if(n.intangible && (roles.has('expense-category') || roles.has('fixed-asset'))) add('nature.intangible','حق استفاده یا علامت تجاری به بررسی قرارداد و دارایی نامشهود نیاز دارد؛ هزینه جاری یا دارایی ثابت مشهود جای آن نیست.');
  if(n.leasehold && roles.has('expense-category')) add('nature.leasehold','بهسازی چندساله ملک استیجاری قبض برق نیست؛ مدت اجاره، منفعت آینده و سیاست سرمایه‌ای شدن باید بررسی شود.');
  if(n.leasehold && roles.has('fixed-asset')) {
    const term=normalizePersian(facts.questionAnswers?.['leasehold.lease-term']?.value || '');
    const policy=normalizePersian(facts.questionAnswers?.['leasehold.capitalization-policy']?.value || '');
    if(!/\d|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده/.test(term) || !/سال|ماه|روز|تا تاریخ/.test(term) || /نامشخص|نامعلوم|نمی دان/.test(term)) add('leasehold.lease-term','مدت باقی‌مانده قطعی اجاره و حق استفاده از محل چقدر است؟');
    // حد سرمایه‌ای مصوب دفتر خودش پاسخ «سیاست» است؛ زیر آن حد را نگهبان جدا رد می‌کند.
    const assetAmount=lines.filter(l=>l.role==='fixed-asset').reduce((sum,l)=>sum+Number(l.debit || 0),0);
    const byPolicy=Number(facts.capitalizationThreshold)>0 && assetAmount>=Number(facts.capitalizationThreshold);
    if(!byPolicy && (!/سرمایه ای|دارایی|بالاتر از حد/.test(policy) || /نیست|نباید|نامشخص|نامعلوم|نمی دان/.test(policy))) add('leasehold.capitalization-policy','طبق سیاست مصوب شرکت، این مبلغ و نوع بهسازی واجد شرایط سرمایه‌ای شدن است؟');
  }
  if(n.writtenOffRecovery && lines.length) issues.push({id:'workflow.written-off-recovery',action:true,text:'وصول طلب حذف‌شده با تسویه طلب باز فرق دارد؛ سند حذف و روش بازیافت باید بررسی شود. مانده افتتاحیه فرضی یا درآمد تازه از حدس ثبت نمی‌شود.'});
  if(n.principal && (roles.has('income-category') || roles.has('expense-category'))) add('nature.loan-principal','اصل وام درآمد یا هزینه نیست؛ اصل بدهی و سود یا کارمزد باید جدا شوند.');
  if(conditionalWaiver(text)) {
    const expected=conditionalPaymentProposal(text,facts);
    const shape=ls=>ls.map(l=>[l.role,l.debit,l.credit].join(':')).sort().join('|');
    if(lines.length && (roles.has('income-category') || (expected && shape(lines)!==shape(expected.lines)))) add('nature.conditional-waiver','بخشودگی وابسته به پرداخت بعدی هنوز تحقق نیافته؛ تعهد پرداخت وجه نیست. فقط پرداخت انجام‌شده را از بدهی کم کن و مانده را تا تحقق شرط نگه دار.');
  }
  if(n.settlement && (roles.has('income-category') || roles.has('expense-category'))) add('nature.prior-settlement','تسویه طلب یا بدهی قبلی نباید درآمد یا هزینه را دوباره شناسایی کند؛ سند مبنای مانده کدام است؟');
  return issues;
}

export function unidentifiedReceiptProposal(text,amount) {
  if(!Number.isSafeInteger(amount) || amount<=0 || !reviewNature(text).unknownReceipt) return null;
  return {summary:'نگهداری واریز ناشناس تا تعیین تکلیف',explanation:'ورود وجه ثبت می‌شود؛ درآمد شناسایی نمی‌شود و منشأ و حق مالکیت هنوز نیازمند پیگیری است.',missingFacts:[],questions:[],lines:[{role:'cash',debit:amount,credit:0},{role:'unidentified-receipt',key:'وجوه دریافتی تعیین‌تکلیف‌نشده',debit:0,credit:amount}]};
}

export const PARTNER_TREATMENTS=Object.freeze({
  funding:'وجه در اختیار شرکت',capital:'افزایش سرمایه مصوب',
  repayCompany:'بازپرداخت بدهی شرکت',withdrawal:'برداشت شخصی',repayPartner:'بازپرداخت طلب شرکت',
});
export function partnerTreatment(text,facts={}) {
  const answer=facts.questionAnswers?.['nature.partner-transfer']?.value;
  if(Object.values(PARTNER_TREATMENTS).includes(answer)) return answer;
  const t=normalizePersian(text);
  const a=normalizePersian(answer || '');
  if(/قرض|وجه در اختیار شرکت/.test(a) && !/بازپرداخت|تسویه|نیست|نبوده/.test(a)) return PARTNER_TREATMENTS.funding;
  if(/برداشت شخصی|مصرف شخصی/.test(a) && !/نیست|نبوده/.test(a)) return PARTNER_TREATMENTS.withdrawal;
  if(/بازپرداخت بدهی شرکت/.test(a)) return PARTNER_TREATMENTS.repayCompany;
  if(/بازپرداخت طلب شرکت/.test(a)) return PARTNER_TREATMENTS.repayPartner;
  if(reviewNature(t).capital) return PARTNER_TREATMENTS.capital;
  if(/برداشت شخصی/.test(t)) return PARTNER_TREATMENTS.withdrawal;
  if(/بازپرداخت بدهی شرکت/.test(t)) return PARTNER_TREATMENTS.repayCompany;
  if(/بازپرداخت طلب شرکت/.test(t)) return PARTNER_TREATMENTS.repayPartner;
  // «که بعداً بهش پس بدیم» یعنی قرض شریک به شرکت؛ پول در اختیار شرکت است.
  if(/در اختیار شرکت|به شرکت قرض داد|قرض\s*(?:داد|گرفتیم)|(?:بهش|به او|بهشون)\s*پس\s*(?:بدیم|میدیم|می دیم|بدهیم|بده)/.test(t)) return PARTNER_TREATMENTS.funding;
  return null;
}
export function partnerTransferProposal(text,amount,facts={}) {
  if(!reviewNature(text).partner || !Number.isSafeInteger(amount) || amount<=0) return null;
  const treatment=partnerTreatment(text,facts);
  if(!treatment) return {summary:'تعیین ماهیت انتقال شریک',explanation:'انتقال شریک به حساب شرکت به‌تنهایی درآمد یا افزایش سرمایه نیست.',missingFacts:[],questions:[{id:'nature.partner-transfer',text:'این انتقال کدام است: وجه در اختیار شرکت، افزایش سرمایه مصوب، بازپرداخت بدهی شرکت، برداشت شخصی یا بازپرداخت طلب شرکت؟'}],lines:[]};
  const outgoing=[PARTNER_TREATMENTS.withdrawal,PARTNER_TREATMENTS.repayCompany].includes(treatment);
  const role=treatment===PARTNER_TREATMENTS.capital?'owner-capital':
    [PARTNER_TREATMENTS.withdrawal,PARTNER_TREATMENTS.repayPartner].includes(treatment)?'partner-receivable':'partner-payable';
  return {summary:treatment,explanation:treatment===PARTNER_TREATMENTS.capital?'آورده مصوب به سرمایه منتقل می‌شود؛ هزینه یا درآمد شناسایی نمی‌شود.':'اثر انتقال در حساب جاری همان شریک نگهداری می‌شود؛ هزینه خرید یا درآمد از انتقال وجه فرض نمی‌شود.',missingFacts:[],questions:[],lines:[{role:'cash',debit:outgoing?0:amount,credit:outgoing?amount:0},{role,debit:outgoing?amount:0,credit:outgoing?0:amount}]};
}
