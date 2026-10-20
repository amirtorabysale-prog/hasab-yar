import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * دور آزمون «تحلیل کن» با AI واقعی روی سایت (دفتر آزمایشی صف، ۲۹ مهر ۱۴۰۵). هر بخش یک ریشه:
 *
 * ۱. واژهٔ کلیدی درون نام: «آقای سعیدی» → «عیدی» → حقوق و دستمزد. خانواده: نام با عنوان یا بی‌عنوان،
 *    «اقای» بی‌کلاه، واژه‌ای که آغازِ واژهٔ رایج دیگر است («شامل»، «پیراهن»)؛ و نمونه‌های منفی
 *    که باید همان دسته را بگیرند.
 * ۲. قاعدهٔ «خالص یا ناخالص» جلوی ماهیتِ پولِ شریک را می‌گرفت، و آنچه جمله گفته بود را دوباره می‌پرسید.
 * ۳. «هر وقت لازم شد پسش میدیم» قرضِ شریک است؛ «برداشت کرد، گفت پسش میده» نه.
 * ۴. گیره‌های موتور به زبانِ کاربر؛ برگشتِ کالا و پرداختِ چندسطری صریحاً «هنوز پشتیبانی نمی‌شود».
 * ۵. سؤالِ تکراریِ مدل با واژه‌های دیگر یک بار پرسیده می‌شود؛ جوابِ بسته کارتِ انتخاب است.
 */

process.env.DATABASE_PATH = tempDatabase('review-queue-ai-round');
process.env.ADMIN_USERNAME = 'queue-round-owner';
process.env.ADMIN_PASSWORD = `queue-round-${crypto.randomUUID()}`;
const db = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const assistant = await import('../server/reviewAssistant.js');
const ai = await import('../server/accountingReviewAi.js');
const { parseFinancialText } = await import('../shared/parser.js');
const { maskNamedPeople } = await import('../shared/categoryRules.js');
const { payrollReviewQuestion } = await import('../shared/reviewRuleProposals.js');
const { partnerTreatment, partnerTransferProposal, reviewNatureViolations, PARTNER_TREATMENTS } = await import('../shared/reviewNature.js');
const { reviewQuestions } = await import('../shared/reviewQuestions.js');
db.ensureAdmin();
const owner = db.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const run = (callback) => db.runInWorkspace('primary', { role: 'owner', userId: owner.id, overdraftApproval: FIXTURE_OVERDRAFT }, callback);
const database = () => db.activeWorkspaceDatabase();
const noApi = () => { throw new Error('No API needed'); };
const before = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-key';
test.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
const T20 = 'شریکمون آقای سعیدی ۵۰ میلیون گذاشت تو کار و ریخت به ملت؛ گفت هر وقت لازم شد پسش میدیم.';
const categoryOf = (text) => parseFinancialText(text).transactions[0]?.category;
const loadCase = async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try { return await vite.ssrLoadModule('/src/features/review/reviewCase.js'); } finally { await vite.close(); }
};

test('واژهٔ کلیدی درون نام یا واژهٔ دیگر دسته نمی‌سازد', () => {
  for (const [text, wrong] of [
    [T20, 'حقوق و دستمزد'],
    ['آقای سعیدی شریکمون ۵۰ میلیون آورد', 'حقوق و دستمزد'],
    ['شریکمون سعیدی ۵۰ میلیون ریخت به حساب', 'حقوق و دستمزد'],
    ['آقای وکیلی ۳ میلیون بابت میز برامون خرید', 'پیمانکار و خدمات بیرونی'],
    ['خانم شاملو ۲ میلیون بابت کاغذ و تونر گرفت', 'خوراک'],
    ['اقای رهنما ۵ میلیون برای تعمیر کولر گرفت', 'اجاره'],
    ['یه پیراهن کار ۲ میلیون برای انبار خریدیم', 'اجاره'],
    ['فاکتور شامل ده قلم کالا بود ۸ میلیون', 'خوراک'],
  ]) assert.notEqual(categoryOf(text), wrong, text);
  assert.equal(categoryOf('خانم شاملو ۲ میلیون بابت کاغذ و تونر گرفت'), 'ملزومات اداری');
  assert.equal(categoryOf('اقای رهنما ۵ میلیون برای تعمیر کولر گرفت'), 'تعمیر و نگهداری');
  assert.equal(categoryOf('فاکتور شامل ده قلم کالا بود ۸ میلیون'), 'مواد و کالا');
  assert.equal(maskNamedPeople('آقای سعیدی ۵۰ میلیون'), 'آقای ، ۵۰ میلیون');
  assert.equal(maskNamedPeople('آقا ۵ میلیون دادیم'), 'آقا ۵ میلیون دادیم');
  assert.equal(maskNamedPeople('پول خانم رو دادیم'), 'پول خانم رو دادیم');
});

test('نمونه‌های منفی: همان واژه‌ها سرِ جای خودشان دسته می‌سازند', () => {
  for (const [text, category] of [
    ['عیدی پرسنل ۲۰ میلیون دادیم', 'حقوق و دستمزد'],
    ['۵ میلیون عیدی کارمندا رو دادیم', 'حقوق و دستمزد'],
    ['حقوق آقای رضایی ۱۵ میلیون رو دادیم', 'حقوق و دستمزد'],
    ['۲ میلیون شام مهمونا رو دادیم', 'خوراک'],
    ['پیک ۲۰۰ هزار گرفت', 'حمل‌ونقل'],
    ['رهن مغازه ۱۰۰ میلیون دادیم', 'اجاره'],
    ['اجاره مغازه ۲۰ میلیون دادیم', 'اجاره'],
    ['۵۰ میلیون جنس فروختیم', 'فروش'],
    ['میفروختیم ۵ میلیون', 'فروش'],
  ]) assert.equal(categoryOf(text), category, text);
});

test('سؤالِ حقوق آنچه جمله گفته را دوباره نمی‌پرسد؛ شناسه همان می‌ماند', () => {
  const ask = (text) => payrollReviewQuestion({ category: 'حقوق و دستمزد', text }).questions[0];
  assert.match(ask('حقوق مهر کارمندها ۳۰ میلیون تومان خالص بود و از بانک ملت واریز شد.').text, /^مبلغ خالص گفته شده/);
  assert.match(ask('حقوق ناخالص مهر ۴۰ میلیون بود').text, /^مبلغ ناخالص گفته شده/);
  assert.match(ask('حقوق مهر ۳۰ میلیون پرداخت شد').text, /خالص پرداختی به کارکنان است یا ناخالص/);
  for (const text of ['حقوق مهر ۳۰ میلیون خالص بود', 'حقوق ناخالص مهر', 'حقوق مهر']) assert.equal(ask(text).id, 'payroll.gross-or-net');
  assert.equal(payrollReviewQuestion({ category: 'حقوق و دستمزد', text: 'خالص بود', answers: { 'payroll.gross-or-net': { value: 'کسوری نداشت' } } }), null);
});

test('پولِ شریک با دستهٔ «حقوق» هم سؤالِ ماهیتِ شریک را می‌گیرد، نه خالص یا ناخالص', () => run(async () => {
  const item = store.recordFinancialEvent(database(), { kind: 'cash-expense', amount: 20_000_000, occurredAt: '2026-10-03', evidence: 'شریکمون ۲۰ میلیون واریز کرد برای حقوق پرسنل', eventNature: 'new', category: 'حقوق و دستمزد' },
    { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['بررسی حسابدار لازم است'] } });
  const proposal = await ai.proposeReview(database(), item.id, { fetcher: noApi });
  assert.equal(proposal.model, 'nature-rules-v1');
  assert.ok(!proposal.questions.some((question) => question.id === 'payroll.gross-or-net'), JSON.stringify(proposal.questions));
  const partner = proposal.questions.find((question) => question.id === 'nature.partner-transfer');
  assert.deepEqual(partner.options, Object.values(PARTNER_TREATMENTS));
}));

test('«پسش میدیم» و «برش می‌گردونیم» قرضِ شریک است؛ «پسش میده» و بی‌نشانه پرسیده می‌شوند', () => {
  assert.equal(partnerTreatment(T20), PARTNER_TREATMENTS.funding);
  assert.equal(partnerTreatment('شریکم ۲۰ میلیون ریخت به حساب، هر وقت خواست برش میگردونیم'), PARTNER_TREATMENTS.funding);
  assert.equal(partnerTreatment('شریک ۱۰ میلیون واریز کرد که بهش پس بدیم'), PARTNER_TREATMENTS.funding);
  assert.equal(partnerTreatment('شریکمون ۱۰ میلیون برداشت کرد و گفت پسش میده'), null);
  assert.equal(partnerTreatment('شریکم ۲۰ میلیون ریخت به حساب شرکت'), null);
  const funded = partnerTransferProposal(T20, 50_000_000);
  assert.deepEqual(funded.lines.map((line) => [line.role, line.debit, line.credit]), [['cash', 50_000_000, 0], ['partner-payable', 0, 50_000_000]]);
});

test('برگشت از فروش: کالا به قیمت فروش به انبار برنمی‌گردد و فروش کم نمی‌شود؟ قفل', () => {
  const said = 'مشتری ۴ میلیون تومان از کالای نقدی که دیروز خریده بود رو برگروند و پولش رو از صندوق پس دادیم.';
  const wrong = reviewNatureViolations(said, [{ role: 'cash', debit: 0, credit: 4_000_000 }, { role: 'inventory-asset', key: 'کالای برگشتی', debit: 4_000_000, credit: 0 }]);
  assert.ok(wrong.some((issue) => issue.id === 'workflow.sales-return' && issue.action), JSON.stringify(wrong));
  const reduced = reviewNatureViolations(said, [{ role: 'cash', debit: 0, credit: 4_000_000 }, { role: 'income-category', key: 'فروش', debit: 4_000_000, credit: 0 }]);
  assert.ok(!reduced.some((issue) => issue.id === 'workflow.sales-return'));
  // خریدِ کالا با پولِ مشتری برگشت نیست.
  assert.ok(!reviewNatureViolations('از مشتری ۴ میلیون گرفتیم و کالا خریدیم', [{ role: 'cash', debit: 0, credit: 4_000_000 }, { role: 'inventory-asset', debit: 4_000_000, credit: 0 }]).some((issue) => issue.id === 'workflow.sales-return'));
});

test('برگشتِ پولِ کالای خریده‌شده: سندِ درستِ AI «جهت ناسازگار» خوانده نمی‌شود، «هنوز پشتیبانی نمی‌شود» گفته می‌شود', () => run(() => {
  const bank = db.saveAccount({ name: 'صندوق دور صف', kind: 'cash' });
  const said = '۵ میلیون تومان از پول اجناسی که هفتهٔ پیش نقد از بازار خریده بودیم پس داده شد و رفت تو صندوق.';
  const item = store.recordFinancialEvent(database(), { kind: 'cash-expense', amount: 5_000_000, occurredAt: '2026-10-03', evidence: said, eventNature: 'new', category: 'سایر هزینه‌ها', accountId: bank.id },
    { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['برگشت کالا، فروش یا خرید قبلی را کم می‌کند؛ دریافت یا پرداخت تازه نیست.'] } });
  const row = database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
  const prepared = assistant.prepareReviewProposal(database(), row, { id: 'p1', state: 'proposed', summary: 'برگشت پول کالا', explanation: '', questions: [], missingFacts: [], workflowBlockers: [],
    lines: [{ role: 'cash', debit: 5_000_000, credit: 0 }, { role: 'inventory-unsplit', key: 'کالای تفکیک‌نشده', debit: 0, credit: 5_000_000 }] });
  assert.ok(prepared.postingBlockers.includes('برگشت کالا یا پول یک خرید یا فروش قبلی هنوز از «تحلیل کن» ثبت نمی‌شود.'), JSON.stringify(prepared.postingBlockers));
  assert.ok(!prepared.postingBlockers.includes('جهت ورود یا خروج نقد با ماهیت سطر مقابل سازگار نیست.'));
}));

test('ارزش افزودهٔ جدا روی فاکتورِ پرداخت‌نشده جمعِ فاکتور را می‌پرسد، نه «پولی که جابه‌جا شد»', async () => {
  const { runGuards } = await import('../shared/guards.js');
  const { EVENT_KINDS, normalizeFinancialEvent } = await import('../shared/financialEvent.js');
  const { factsFromEvent } = await import('../shared/eventFacts.js');
  const { decide } = await import('../shared/accountingDecision.js');
  const reasonOf = (kind, evidence) => {
    const event = normalizeFinancialEvent({ kind, amount: 40_000_000, occurredAt: '2026-10-20T00:00:00.000Z', category: 'مواد و کالا', counterparty: 'شرکت پخش گلستان', ...(kind.endsWith('opened') ? {} : { accountId: 'cash' }), evidence });
    const facts = factsFromEvent(event);
    return runGuards(event, facts, { decision: decide(facts, { today: '2026-10-20T00:00:00.000Z' }), vat: { ratesBps: [1000], rateBps: 1000, outputTax: 0 } }).checks.find((check) => check.name === 'vat-split')?.reason;
  };
  assert.equal(reasonOf(EVENT_KINDS.PAYABLE_OPENED, 'فاکتور خرید از شرکت پخش گلستان زدیم ۴۰ میلیون تومان به‌علاوهٔ ۱۰ درصد ارزش افزوده، پولش هنوز ندادیم.'), 'مبلغ بدون ارزش افزوده گفته شده؛ جمع فاکتور با ارزش افزوده چقدر است؟');
  assert.equal(reasonOf(EVENT_KINDS.RECEIVABLE_OPENED, 'فاکتور فروش ۴۰ میلیون به علاوه ارزش افزوده زدیم، هنوز پولشو نداده'), 'مبلغ بدون ارزش افزوده گفته شده؛ جمع فاکتور با ارزش افزوده چقدر است؟');
  assert.equal(reasonOf(EVENT_KINDS.CASH_EXPENSE, 'خرید ۴۰ میلیون به علاوه ارزش افزوده نقد دادیم'), 'مبلغ بدون ارزش افزوده گفته شده؛ پولی که واقعاً جابه‌جا شد چقدر بود؟');
});

test('سؤالِ تکراریِ مدل با واژه‌های دیگر یک بار؛ «شروع» و «پایانِ» پوشش دو سؤال؛ گزینه‌ها می‌مانند', () => {
  const insurance = reviewQuestions({ questions: [
    { id: 'insurance.treatment', text: 'این پرداخت ۱۲٬۰۰۰٬۰۰۰ تومانی برای پیش‌پرداخت بیمه ثبت شود یا هزینهٔ بیمهٔ دوره؟' },
    { id: 'coverage.start', text: 'پوشش بیمه از چه تاریخی شروع می‌شود؟' },
  ], missingFacts: ['مشخص شود این پرداخت ۱۲٬۰۰۰٬۰۰۰ تومانی برای کدام نوع بیمه ثبت شود: پیش‌پرداخت بیمه یا هزینهٔ بیمهٔ دوره.'] });
  assert.deepEqual(insurance.map((question) => question.id), ['insurance.treatment', 'coverage.start']);
  const period = reviewQuestions({ questions: [{ id: 'coverage.start', text: 'تاریخ شروع پوشش بیمه چیست؟' }, { id: 'coverage.end', text: 'تاریخ پایان پوشش بیمه چیست؟' }] });
  assert.equal(period.length, 2);
  const [choice] = reviewQuestions({ questions: [{ id: 'nature.partner-transfer', text: 'این انتقال کدام است؟', options: Object.values(PARTNER_TREATMENTS) }] });
  assert.deepEqual(choice.options, Object.values(PARTNER_TREATMENTS));
});

test('کارتِ صف: دلیلِ مشخص تیتر می‌شود و هر دلیل جملهٔ خودش است', async () => {
  const { reviewCase } = await loadCase();
  const partner = reviewCase({ approvalNextStep: 'manual-review', approvalBlocked: true, confidence: { reasons: [
    'نوع تراکنش از متن با اطمینان کافی مشخص نیست.', 'نوع این تراکنش با اطمینان کم تشخیص داده شد؛ لطفاً بررسی کن.',
    'نوع: متن هم‌زمان نشانهٔ روشن درآمد یا هزینه ندارد.', 'پای شریک یا سهامدار در میان است؛ آورده، قرض یا برداشت بودنش را حسابدار تعیین می‌کند.',
    'انتقال وجه شریک درآمد یا هزینه شرکت نیست', 'این گفته هنوز نقشهٔ سند قطعی ندارد',
  ] } });
  assert.equal(partner.headline, 'پای شریک یا سهامدار در میان است');
  assert.equal(partner.detail, 'آورده، قرض یا برداشت بودنش را حسابدار تعیین می‌کند. انتقال وجه شریک درآمد یا هزینه شرکت نیست. این گفته هنوز نقشهٔ سند قطعی ندارد.');
});

test('گیره‌های موتور به زبانِ کاربر: مشکل و قدمِ بعدی؛ بی‌تکرار؛ «هنوز پشتیبانی نمی‌شود» صریح', async () => {
  const { plainBlocker, plainBlockers, proposalBrief, remainingBlockers } = await loadCase();
  const split = plainBlocker('این ثبت نقدی چندبخشی یا تخصصی است؛ ابتدا مسیر تخصصی یا سطرهای عملیاتی آن باید تکمیل شود.');
  assert.match(split.problem, /اصل و سود وام/);
  assert.match(split.fix, /رد با دلیل/);
  assert.equal(split.unsupported, true);
  assert.equal(plainBlockers(['برای ورود انبار، نام کالا، مقدار و واحد را مشخص کن.', 'اطلاعات کالای این سطر برای ورود انبار کامل نیست.']).length, 1);
  assert.equal(plainBlocker('برگشت کالا از مشتری باید فروش را کم کند؛ برگرداندن کالا به انبار به قیمت فروش سند درستی نیست.').unsupported, true);
  assert.equal(plainBlocker('برگشت کالا یا پول یک خرید یا فروش قبلی هنوز از «تحلیل کن» ثبت نمی‌شود.').unsupported, true);
  assert.equal(plainBlocker('جهت ورود یا خروج نقد با ماهیت سطر مقابل سازگار نیست.').unsupported, false);
  assert.deepEqual(plainBlocker('متنی که نقشه‌اش نیست.'), { problem: 'متنی که نقشه‌اش نیست.', fix: 'در «گفت‌وگو با دستیار» بنویس چه چیزی درست است تا پیشنهاد تازه بدهد.', unsupported: false });
  const loan = proposalBrief({ canPost: false, summary: 'قسط وام' }, { conditions: ['این ثبت نقدی چندبخشی یا تخصصی است؛ ابتدا مسیر تخصصی یا سطرهای عملیاتی آن باید تکمیل شود.'] });
  assert.equal(loan.unsupported, true);
  assert.match(loan.problem, /چندسطری/);
  // «سطرهای معتبر ندارد» زیرِ سؤالِ بی‌جواب تکرار نمی‌شود؛ بی سؤال، گیرهٔ اول همان «مشکل» است و فهرست از دومی.
  const lines = 'پیشنهاد هنوز سطرهای معتبر و متوازن برای ثبت ندارد.', bank = 'بانک یا صندوق واقعی را انتخاب کن.';
  assert.deepEqual(remainingBlockers([lines, bank], { fromQuestions: true }).map((item) => item.problem), ['معلوم نیست پول از کدام بانک یا صندوق جابه‌جا شده.']);
  assert.deepEqual(remainingBlockers([lines, bank], { fromQuestions: false }).map((item) => item.problem), ['معلوم نیست پول از کدام بانک یا صندوق جابه‌جا شده.']);
  assert.deepEqual(remainingBlockers([bank, lines], { fromQuestions: false }).map((item) => item.problem), [lines]);
  // سؤالِ بی‌جواب مقدم است و «پشتیبانی نمی‌شود» را پنهان نمی‌کند تا جوابش داده شود.
  assert.equal(proposalBrief({ canPost: false }, { unanswered: [{}], conditions: ['این ثبت نقدی چندبخشی یا تخصصی است؛ …'] }).unsupported, false);
});

test('ReviewAssistant: گیره‌ها از نقشهٔ زبانِ کاربر، جوابِ بسته با کارتِ انتخاب، بی <label> دورِ دکمه‌ها', () => {
  const source = readFileSync(new URL('../src/features/review/ReviewAssistant.jsx', import.meta.url), 'utf8');
  assert.match(source, /remainingBlockers\(conditions, brief\)/);
  assert.match(source, /<dd className="mt-0\.5 text-\[13px\] text-muted">\{brief\.fix\}<\/dd>/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio" aria-checked=\{value === option\}/);
  assert.match(source, /current\.options\?\.length\s*\? <div/);
  assert.match(source, /هنوز پشتیبانی نمی‌شود/);
  assert.doesNotMatch(source, /blockerHint/);
});
