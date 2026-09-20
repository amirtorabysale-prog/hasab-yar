import { extractAmounts, normalizePersian, parseFinancialText } from './parser.js';

// «اشتباه شد…» و «اشتباه گفتم…» همان‌قدر طبیعی‌اند که «نه…»، ولی شناخته
// نمی‌شدند: جمله به‌جای اصلاحِ ثبت قبلی، یک ثبت تازه می‌ساخت. «ببخشید» عمداً
// اینجا نیست — تنهایی می‌تواند شروعِ مؤدبانهٔ یک جملهٔ عادی باشد، و «نه
// ببخشید» از قبل با «نه» گرفته می‌شود.
const CORRECTION_START = /^(نه|اصلاح|اشتباه|منظورم|درستش|تغییرش|بزن)(?=[\s،,:-]|$)/;
const CORRECTION_ACTION = /(تغییر بده|اصلاح کن|حسابش کن|دسته اش را|دسته‌اش را)/;

export function isCorrectionCommand(input = '') {
  const text = normalizePersian(input);
  return CORRECTION_START.test(text) || CORRECTION_ACTION.test(text);
}

function includesNormalized(text, value) {
  const needle = normalizePersian(value);
  return needle && text.includes(needle);
}

export function previewCorrection(command, current = {}, { learnings = [], accounts = [], categories = [] } = {}) {
  const text = normalizePersian(command);
  if (!text || !current?.id || !isCorrectionCommand(text)) return { canApply: false, changes: {}, changedFields: [], explanation: 'فرمان اصلاح مشخص نیست.' };
  const changes = {};
  const changedFields = [];
  // «نه» در ابتدای جمله یک اصلاح‌گر گفتاری است، نه عدد ۹.
  const amountText = text.replace(/^نه\s*[،,:-]?\s*/, '');
  const amountSpan = extractAmounts(amountText).spans[0];
  if (amountSpan?.amount > 0 && Number(amountSpan.amount) !== Number(current.amount)) {
    changes.amount = amountSpan.amount;
    changedFields.push('amount');
  }

  const explicitIncome = /(درآمد|فروش|دریافت|واریز|گرفتم)/.test(text);
  const explicitExpense = /(هزینه|خرج|خرید|پرداخت|دادم)/.test(text);
  const matchedCategory = categories.find((category) => includesNormalized(text, category.name));
  const classifierAmount = amountSpan?.amount || Number(current.amount) || 1;
  const classified = parseFinancialText(`${classifierAmount} تومان ${text}`, { learnings, source: 'text' }).transactions[0];
  const categoryIntent = /(بزن|دسته|جزو)/.test(text) || matchedCategory || (classified?.category && !/^سایر /.test(classified.category));
  if (matchedCategory && matchedCategory.name !== current.category) {
    changes.category = matchedCategory.name;
    changes.type = matchedCategory.type;
    changedFields.push('category');
    if (matchedCategory.type !== current.type) changedFields.push('type');
  } else if (categoryIntent && classified?.category && classified.category !== current.category) {
    changes.category = classified.category;
    changedFields.push('category');
  }
  if (!matchedCategory && explicitIncome !== explicitExpense) {
    const type = explicitIncome ? 'income' : 'expense';
    if (type !== current.type) { changes.type = type; changedFields.push('type'); }
  }

  const matchedAccount = accounts.find((account) => includesNormalized(text, account.name));
  if (matchedAccount && matchedAccount.id !== current.accountId) {
    changes.accountId = matchedAccount.id;
    changes.accountName = matchedAccount.name;
    changedFields.push('account');
  }
  const uniqueFields = [...new Set(changedFields)];
  return {
    canApply: uniqueFields.length > 0,
    changes,
    changedFields: uniqueFields,
    explanation: uniqueFields.length ? `اصلاح ${uniqueFields.map((field) => ({ amount: 'مبلغ', type: 'نوع', category: 'دسته', account: 'حساب' })[field]).join(' و ')}` : 'تغییری نسبت به آخرین ثبت پیدا نشد.',
  };
}
