const DIGITS = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

const VALUES = {
  صفر: 0, یک: 1, یه: 1, ی: 1, دو: 2, سه: 3, چهار: 4, چار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9,
  ده: 10, یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پونزده: 15, پانزده: 15, شانزده: 16, هفده: 17, هجده: 18, نوزده: 19,
  بیست: 20, سی: 30, چهل: 40, پنجاه: 50, شصت: 60, شست: 60, هفتاد: 70, هشتاد: 80, نود: 90,
  صد: 100, یکصد: 100, دویست: 200, سیصد: 300, سیصدتا: 300, چهارصد: 400, چارصد: 400,
  پانصد: 500, پونصد: 500, ششصد: 600, شیشصد: 600, هفتصد: 700, هشتصد: 800, نهصد: 900,
};
const FRACTIONS = { نیم: 0.5, نصف: 0.5 };
const SCALES = { هزار: 1_000, هزارتا: 1_000, میلیون: 1_000_000, میلیارد: 1_000_000_000 };
const NUMBER_WORDS = new Set([...Object.keys(VALUES), ...Object.keys(FRACTIONS), ...Object.keys(SCALES)]);
const INCOME_WORDS = ['فروش', 'درآمد', 'دریافت', 'واریز', 'واریزی', 'گرفتم', 'فروختم', 'دخل', 'دستمزد گرفتم', 'به حسابم آمد', 'به حسابم اومد'];
const EXPENSE_WORDS = ['هزینه', 'خرج', 'خرید', 'خریدم', 'حقوق', 'اجاره', 'پرداخت', 'دادم', 'برداشت', 'قبض', 'کرایه', 'مواد'];
const CATEGORY_RULES = [
  ['فروش', ['فروش', 'فروختم']],
  ['خدمات', ['خدمات', 'سرویس']],
  ['پروژه و دستمزد', ['پروژه', 'دستمزد گرفتم']],
  ['حقوق و دستمزد', ['حقوق', 'دستمزد دادم']],
  ['اجاره', ['اجاره']],
  ['مواد و کالا', ['مواد', 'کالا', 'موجودی', 'خرید جنس']],
  ['حمل‌ونقل', ['اسنپ', 'تاکسی', 'کرایه', 'پیک']],
  ['خوراک', ['غذا', 'خوراک', 'ناهار', 'شام', 'اسنپ فود']],
  ['قبوض', ['قبض', 'آب', 'برق', 'گاز', 'اینترنت']],
];
const LEARNING_STOP_WORDS = new Set(['امروز', 'دیروز', 'تومان', 'تومن', 'تومنی', 'ریال', 'بابت', 'برای', 'از', 'به', 'را', 'رو', 'کردم', 'دادم', 'گرفتم', 'داشتم', 'خریدم', 'فروختم', 'پرداخت', 'هزینه', 'درآمد', 'فروش', 'حقوق', 'و']);

export const FINANCIAL_SPEECH_PHRASES = [
  'تومان', 'تومن', 'ریال', 'هزار', 'میلیون', 'میلیارد', 'نیم', 'فروش', 'درآمد', 'هزینه',
  'حقوق', 'اجاره', 'خرید', 'پرداخت', 'دریافت', 'مواد', 'کالا', 'قبض', 'کرایه', 'اسنپ',
];

export function normalizePersian(input) {
  return String(input || '')
    .replace(/[۰-۹٠-٩]/g, (digit) => DIGITS[digit])
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[‌ـ]/g, ' ')
    .replace(/٬/g, ',').replace(/٫/g, '.')
    .replace(/\s+/g, ' ').trim();
}

function parseNumericToken(token) {
  const value = String(token || '');
  if (!/^\d[\d,.]*$/.test(value)) return null;
  const commaParts = value.split(',');
  const dotParts = value.split('.');
  if (commaParts.length > 2 || (commaParts.length === 2 && commaParts[1].length === 3)) return Number(value.replace(/,/g, ''));
  if (dotParts.length > 2 || (dotParts.length === 2 && dotParts[1].length === 3)) return Number(value.replace(/\./g, ''));
  if (commaParts.length === 2) return Number(`${commaParts[0]}.${commaParts[1]}`);
  return Number(value);
}

export function wordsToNumber(tokens) {
  let total = 0;
  let current = 0;
  let lastLargeScale = 0;
  for (const rawToken of tokens) {
    const token = normalizePersian(rawToken);
    if (!token || token === 'و') continue;
    const numeric = parseNumericToken(token);
    if (numeric != null) current += numeric;
    else if (VALUES[token] != null) current += VALUES[token];
    else if (FRACTIONS[token] != null) current += FRACTIONS[token];
    else if (SCALES[token]) {
      const scale = SCALES[token];
      total += (current || 1) * scale;
      current = 0;
      lastLargeScale = scale >= 1_000_000 ? scale : 0;
    }
  }
  // در گفتار روزمره «دو میلیون و پونصد» یعنی دو میلیون و پانصد هزار.
  if (current && lastLargeScale >= 1_000_000 && current < 1) total += current * lastLargeScale;
  else if (current && lastLargeScale >= 1_000_000 && current < 1_000) total += current * (lastLargeScale / 1_000);
  else total += current;
  return Math.round(total);
}

function tokenize(text) {
  return [...text.matchAll(/[0-9][0-9,.]*|[آ-ی]+/g)]
    .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

function isNumericWord(value) { return /^\d/.test(value) || NUMBER_WORDS.has(value); }

export function extractAmounts(input) {
  const text = normalizePersian(input);
  const tokens = tokenize(text);
  const spans = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isNumericWord(token.value)) continue;
    const collected = [token.value];
    let cursor = index + 1;
    let end = token.end;
    while (cursor < tokens.length) {
      const next = tokens[cursor];
      if (isNumericWord(next.value)) {
        collected.push(next.value);
        end = next.end;
        cursor += 1;
        continue;
      }
      if (next.value === 'و' && isNumericWord(tokens[cursor + 1]?.value)) {
        collected.push(next.value);
        end = next.end;
        cursor += 1;
        continue;
      }
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
  const words = normalized.split(/\s+/).filter((word) => word && !NUMBER_WORDS.has(word) && !LEARNING_STOP_WORDS.has(word));
  return words.slice(0, 3).join(' ').trim();
}

function containsAny(text, words) { return words.some((word) => text.includes(word)); }

function classify(context, learnings = []) {
  const normalizedContext = normalizePersian(context);
  const learned = learnings.find((item) => normalizedContext.includes(normalizePersian(item.keyword)));
  const hasIncome = containsAny(normalizedContext, INCOME_WORDS);
  const hasExpense = containsAny(normalizedContext, EXPENSE_WORDS);
  let type = hasIncome && !hasExpense ? 'income' : 'expense';
  let confidence = hasIncome !== hasExpense ? 0.93 : 0.58;
  let category = learned?.category;
  if (learned) confidence = Math.max(confidence, 0.96);
  if (!category) category = CATEGORY_RULES.find(([, words]) => containsAny(normalizedContext, words))?.[0];
  if (!category) category = type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها';
  const incomeCategories = new Set(['فروش', 'خدمات', 'پروژه و دستمزد', 'سایر درآمدها']);
  if (incomeCategories.has(category)) type = 'income';
  return { type, category, confidence };
}

export function parseFinancialText(input, { learnings = [], averages = {}, source = 'text' } = {}) {
  const { text, spans } = extractAmounts(input);
  const signalWords = [...INCOME_WORDS, ...EXPENSE_WORDS, ...CATEGORY_RULES.flatMap(([, words]) => words)];
  const transactions = spans.map((span, index) => {
    const previousEnd = spans[index - 1]?.end ?? 0;
    const nextStart = spans[index + 1]?.start ?? text.length;
    const afterAmount = text.slice(span.end, nextStart).trim();
    const beforeAmount = text.slice(previousEnd, span.start).trim();
    const context = containsAny(afterAmount, signalWords) ? afterAmount : `${beforeAmount} ${afterAmount}`.trim();
    const classified = classify(context, learnings);
    let amount = span.amount;
    if (context.includes('ریال') && !containsAny(context, ['تومان', 'تومن'])) amount = Math.round(amount / 10);
    const average = Number(averages[classified.type] || 0);
    const unusual = average > 0 && amount >= average * 5;
    const ambiguous = classified.confidence < 0.7;
    return {
      amount, type: classified.type, category: classified.category, rawText: context || text,
      confidence: classified.confidence, needsReview: unusual || ambiguous, source,
      warning: unusual ? 'این مبلغ بیشتر از پنج برابر میانگین ثبت‌های مشابه توست. مطمئنی؟' : ambiguous ? 'نوع این تراکنش با اطمینان کم تشخیص داده شد؛ لطفاً بررسی کن.' : null,
      alternatives: [],
    };
  });
  return { transcript: text, transactions };
}

export function parseRecognitionCandidates(candidates, options = {}) {
  const unique = [];
  for (const candidate of candidates || []) {
    const transcript = normalizePersian(typeof candidate === 'string' ? candidate : candidate?.transcript);
    if (!transcript || unique.some((item) => item.transcript === transcript)) continue;
    unique.push({ transcript, speechConfidence: Number(typeof candidate === 'string' ? 0 : candidate?.confidence) || 0 });
  }
  if (!unique.length) return { transcript: '', transactions: [], engine: 'browser-live' };
  const parsed = unique.map((candidate) => {
    const result = parseFinancialText(candidate.transcript, { ...options, source: 'voice' });
    const score = result.transactions.length * 250
      + result.transactions.reduce((sum, item) => sum + item.confidence * 100, 0)
      + candidate.speechConfidence * 30;
    return { ...candidate, result, score };
  }).sort((left, right) => right.score - left.score);
  const best = parsed[0];
  if (!best.result.transactions.length) return { ...best.result, engine: 'browser-live', speechConfidence: best.speechConfidence };
  const transactions = best.result.transactions.map((item, index) => {
    const alternatives = [...new Set(parsed.slice(1)
      .filter((candidate) => candidate.result.transactions.length === best.result.transactions.length)
      .map((candidate) => candidate.result.transactions[index]?.amount)
      .filter((amount) => Number.isFinite(amount) && amount > 0 && amount !== item.amount))].slice(0, 2);
    if (!alternatives.length) return { ...item, speechConfidence: best.speechConfidence };
    return {
      ...item,
      speechConfidence: best.speechConfidence,
      alternatives,
      needsReview: true,
      warning: item.warning || 'چند مبلغ متفاوت شنیده شد؛ مبلغ را با دقت بررسی کن.',
    };
  });
  return { ...best.result, transactions, engine: 'browser-live', speechConfidence: best.speechConfidence };
}
