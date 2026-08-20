const DIGITS = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const values = {
  صفر: 0, یک: 1, يه: 1, یه: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, هفت: 7, هشت: 8, نه: 9,
  ده: 10, یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پانزده: 15, شانزده: 16, هفده: 17, هجده: 18, نوزده: 19,
  بیست: 20, سی: 30, چهل: 40, پنجاه: 50, شصت: 60, هفتاد: 70, هشتاد: 80, نود: 90,
  صد: 100, یکصد: 100, دویست: 200, سیصد: 300, چهارصد: 400, پانصد: 500, ششصد: 600, هفتصد: 700, هشتصد: 800, نهصد: 900,
};
const scales = { هزار: 1_000, میلیون: 1_000_000, میلیارد: 1_000_000_000 };
const numberWords = new Set([...Object.keys(values), ...Object.keys(scales)]);
const incomeWords = ['فروش', 'درآمد', 'دریافت', 'واریزی', 'گرفتم', 'فروختم', 'دستمزد گرفتم'];
const expenseWords = ['هزینه', 'خرید', 'حقوق', 'اجاره', 'پرداخت', 'دادم', 'برداشت', 'قبض', 'کرایه'];
const categoryRules = [
  ['فروش', ['فروش', 'فروختم']], ['خدمات', ['خدمات', 'سرویس']], ['پروژه و دستمزد', ['پروژه', 'دستمزد گرفتم']],
  ['حقوق و دستمزد', ['حقوق', 'دستمزد دادم']], ['اجاره', ['اجاره']], ['مواد و کالا', ['مواد', 'کالا', 'موجودی', 'خرید جنس']],
  ['حمل‌ونقل', ['اسنپ', 'تاکسی', 'کرایه', 'پیک']], ['خوراک', ['غذا', 'خوراک', 'ناهار', 'شام', 'اسنپ فود', 'اسنپ‌فود']], ['قبوض', ['قبض', 'آب', 'برق', 'گاز', 'اینترنت']],
];
const learningStopWords = new Set(['امروز', 'دیروز', 'تومان', 'تومن', 'ریال', 'بابت', 'برای', 'از', 'به', 'را', 'رو', 'کردم', 'دادم', 'گرفتم', 'داشتم', 'خریدم', 'فروختم', 'پرداخت', 'هزینه', 'درآمد', 'فروش', 'حقوق', 'و']);

export function normalizePersian(input) {
  return String(input || '').replace(/[۰-۹٠-٩]/g, (digit) => DIGITS[digit]).replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/٬/g, ',').replace(/\s+/g, ' ').trim();
}

export function wordsToNumber(tokens) {
  let total = 0; let current = 0;
  for (const token of tokens) {
    if (token === 'و') continue;
    if (values[token] != null) current += values[token];
    else if (scales[token]) { total += (current || 1) * scales[token]; current = 0; }
  }
  return total + current;
}

function tokenize(text) {
  return [...text.matchAll(/[0-9][0-9,.]*|[آ-ی]+/g)].map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

export function extractAmounts(input) {
  const text = normalizePersian(input);
  const tokens = tokenize(text);
  const spans = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^\d/.test(token.value)) {
      let amount = Number(token.value.replace(/[,.]/g, ''));
      let end = token.end;
      if (scales[tokens[index + 1]?.value]) { amount *= scales[tokens[index + 1].value]; end = tokens[index + 1].end; index += 1; }
      if (amount > 0) spans.push({ amount, start: token.start, end });
      continue;
    }
    if (!numberWords.has(token.value)) continue;
    const collected = [token.value];
    let cursor = index + 1;
    let end = token.end;
    while (cursor < tokens.length) {
      const next = tokens[cursor];
      if (numberWords.has(next.value)) { collected.push(next.value); end = next.end; cursor += 1; continue; }
      if (next.value === 'و' && numberWords.has(tokens[cursor + 1]?.value)) { collected.push(next.value); end = next.end; cursor += 1; continue; }
      break;
    }
    const amount = wordsToNumber(collected);
    if (amount > 0) spans.push({ amount, start: token.start, end });
    index = cursor - 1;
  }
  return { text, spans };
}

export function inferLearningKeyword(input) {
  const normalized = normalizePersian(input).replace(/[0-9,.]/g, ' ');
  const words = normalized.split(/\s+/).filter((word) => word && !numberWords.has(word) && !learningStopWords.has(word));
  return words.slice(0, 3).join(' ').trim();
}

function containsAny(text, words) { return words.some((word) => text.includes(word)); }

function classify(context, learnings = []) {
  const learned = learnings.find((item) => context.includes(normalizePersian(item.keyword)));
  let type = containsAny(context, incomeWords) ? 'income' : containsAny(context, expenseWords) ? 'expense' : 'expense';
  let confidence = containsAny(context, [...incomeWords, ...expenseWords]) ? 0.9 : 0.58;
  let category = learned?.category;
  if (learned) confidence = Math.max(confidence, 0.94);
  if (!category) category = categoryRules.find(([, words]) => containsAny(context, words))?.[0];
  if (!category) category = type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها';
  const incomeCategories = new Set(['فروش', 'خدمات', 'پروژه و دستمزد', 'سایر درآمدها']);
  if (incomeCategories.has(category)) type = 'income';
  return { type, category, confidence };
}

export function parseFinancialText(input, { learnings = [], averages = {} } = {}) {
  const { text, spans } = extractAmounts(input);
  const transactions = spans.map((span, index) => {
    const previousEnd = spans[index - 1]?.end ?? 0;
    const nextStart = spans[index + 1]?.start ?? text.length;
    const afterAmount = text.slice(span.end, nextStart).trim();
    const beforeAmount = text.slice(previousEnd, span.start).trim();
    const context = containsAny(afterAmount, [...incomeWords, ...expenseWords, ...categoryRules.flatMap(([, words]) => words)])
      ? afterAmount
      : `${beforeAmount} ${afterAmount}`.trim();
    const classified = classify(context, learnings);
    let amount = span.amount;
    if (context.includes('ریال') && !context.includes('تومان')) amount = Math.round(amount / 10);
    const average = averages[classified.type] || 0;
    const unusual = average > 0 && amount >= average * 5;
    const ambiguous = classified.confidence < 0.7;
    return {
      amount, type: classified.type, category: classified.category, rawText: context || text,
      confidence: classified.confidence, needsReview: unusual || ambiguous, source: 'text',
      warning: unusual ? `این مبلغ بیشتر از پنج برابر میانگین ثبت‌های مشابه توست. مطمئنی؟` : ambiguous ? 'نوع این تراکنش با اطمینان کم تشخیص داده شد؛ لطفاً بررسی کن.' : null,
      alternatives: [],
    };
  });
  return { transcript: text, transactions };
}
