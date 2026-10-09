#!/usr/bin/env node
/**
 * ارزیابی «فهم رویداد» روی مجموعهٔ پذیرش (`docs/testing/understanding-acceptance-v1.json`).
 *
 *   node scripts/understanding-eval.mjs --provider=legacy   مسیر قطعی امروز، همهٔ ۶۰ گفته
 *   node scripts/understanding-eval.mjs --provider=oracle   مسیر تازه با فهمِ درستِ دست‌نوشته (فقط بیان رسمی)
 *   node scripts/understanding-eval.mjs --provider=openai   مسیر تازه با مدل واقعی؛ OPENAI_API_KEY لازم است
 *   … --provider=openai --set=stress40   ۴۰ سناریوی قفل‌شدهٔ آزمون استرس
 *   … --provider=openai --set=v3         ۳۰ سناریوی مهر ۱۴۰۵ (`docs/testing/scenarios-30-v3.json`)
 *
 * نتیجهٔ مورد انتظارِ دو مجموعهٔ آخر متن آزادِ انسانی است («Dr صندوق ۸٫۵ / Cr
 * فروش ۸٫۵») و خودکار داوری نمی‌شود؛ خروجی‌شان برگهٔ داوری انسانی است: متن،
 * انتظار، مسیر، سطرهای پیشنهادی و سؤال‌ها کنار هم.
 *
 * «oracle» دقت مدل را نمی‌سنجد؛ می‌سنجد که اگر فهم درست باشد، اعتبارسنجی، تبدیل،
 * موتور قاعده و ثبت درست کار می‌کنند. دقتِ مدل فقط با `openai` و روی محیط
 * آزمایشی سنجیده می‌شود — هیچ‌وقت روی دفتر اصلی.
 *
 * هر گفته روی یک دفتر تازه و یکسان اجرا می‌شود (دیتابیس موقت)، پس نتیجه‌ها روی هم
 * اثر نمی‌گذارند و هیچ دادهٔ واقعی‌ای لمس نمی‌شود. خروجی در `--out` (پیش‌فرض
 * `docs/testing/understanding-eval-<provider>.json` و `.md`) نوشته می‌شود.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
const provider = args.provider || 'oracle';
if (!['legacy', 'oracle', 'openai'].includes(provider)) throw new Error('provider باید legacy، oracle یا openai باشد.');
if (provider === 'openai' && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
  throw new Error('برای ارزیابی با مدل واقعی OPENAI_API_KEY (یا GEMINI_API_KEY) را روی محیط آزمایشی تنظیم کن.');
}
const fixture = JSON.parse(readFileSync(join(root, 'docs/testing/understanding-acceptance-v1.json'), 'utf8'));
const NOW = new Date(fixture.now);
const oracleOf = (value) => (typeof value === 'string' && value.startsWith('fixture:')
  ? JSON.parse(readFileSync(join(root, 'test/fixtures', value.slice('fixture:'.length)), 'utf8')) : value);

const scratch = mkdtempSync(join(tmpdir(), 'hy-understanding-eval-'));
process.env.DATABASE_PATH = join(scratch, 'eval.sqlite');
process.env.ADMIN_USERNAME = 'eval-owner';
process.env.ADMIN_PASSWORD = `eval-only-${Date.now()}-password`;
const load = (path) => import(pathToFileURL(join(root, path)).href);
const database = await load('server/db.js');
const accounting = await load('server/accounting.js');
const { runVoice } = await load('test/helpers/voicePipeline.js');
const { detectCaptureTransfer } = await load('shared/bankSpeech.js');
const { hasCompositeAmounts } = await load('shared/parser.js');
const { needsUnquantifiedReview } = await load('shared/reviewIntake.js');
const { todayPersian } = await load('shared/persianDate.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

// ---------------------------------------------------------------------------
// مدل: دست‌نوشته یا واقعی
// ---------------------------------------------------------------------------

const oracles = new Map();
for (const seed of fixture.ledger.seed) oracles.set(seed.text, seed.understanding);
for (const event of fixture.events) for (const variant of event.variants) if (variant.oracle) oracles.set(variant.text, oracleOf(variant.oracle));

const oracleFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const said = JSON.parse(body.input?.[1]?.content?.[0]?.text || body.contents?.[0]?.parts?.[0]?.text || '{}')['گفتهٔ کاربر'];
  const output = oracles.get(said);
  if (!output) throw Object.assign(new Error('oracle missing'), { name: 'TypeError' });
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 0, output_tokens: 0 } }) };
};
const seeds = new Set(fixture.ledger.seed.map((seed) => seed.text));
const fetcher = (url, init) => {
  const body = JSON.parse(init.body);
  const said = JSON.parse(body.input?.[1]?.content?.[0]?.text || body.contents?.[0]?.parts?.[0]?.text || '{}')['گفتهٔ کاربر'];
  return provider === 'openai' && !seeds.has(said) ? fetch(url, init) : oracleFetch(url, init);
};
const env = provider === 'openai' ? process.env : { OPENAI_API_KEY: 'oracle', OPENAI_UNDERSTANDING_MODEL: 'oracle' };

// ---------------------------------------------------------------------------
// دفترِ یکسان برای هر گفته
// ---------------------------------------------------------------------------

let counter = 0;
async function freshLedger() {
  counter += 1;
  const workspace = database.createWorkspace(owner.id, { name: `ارزیابی ${counter}`, profileType: 'business' });
  const run = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
  const aliases = {};
  await run(async () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all', capitalizationThreshold: fixture.ledger.capitalizationThreshold ?? null });
    for (const account of fixture.ledger.accounts) {
      const saved = database.saveAccount({ ...(account.id ? { id: account.id } : {}), name: account.name, kind: account.kind, bankId: account.bankId, openingBalance: account.openingBalance });
      aliases[account.alias] = saved.id;
    }
    for (const name of fixture.ledger.contacts) database.saveContact({ name });
    for (const seed of fixture.ledger.seed) {
      const item = await database.createUnderstandingCase({ text: seed.text, clientId: `seed-${seed.text.length}` }, { fetcher: oracleFetch, env: { OPENAI_API_KEY: 'oracle', OPENAI_UNDERSTANDING_MODEL: 'oracle' }, now: NOW });
      database.commitUnderstandingCase(item.id, { now: NOW });
    }
  });
  return { run, aliases };
}

// ---------------------------------------------------------------------------
// داوری
// ---------------------------------------------------------------------------

const KIND_OF_FLOW = { out: 'cash-out', in: 'cash-in', payable: 'obligation-payable', receivable: 'obligation-receivable', transfer: 'transfer' };
const LEGACY_KIND = { 'cash-expense': 'cash-out', 'cash-income': 'cash-in', 'payable-opened': 'obligation-payable', 'receivable-opened': 'obligation-receivable', 'fixed-asset-purchase': 'cash-out', 'capital-contribution': 'cash-in' };
const key = ([kind, amount]) => `${kind}:${amount}`;

function judge(expect, posted, { route }) {
  const expected = (expect.post || []).map(key).sort();
  const got = posted.map(key).sort();
  const forbiddenAmount = posted.find(([, amount]) => (expect.forbid || []).includes(amount));
  const forbiddenKind = posted.find(([kind]) => (expect.forbidKinds || []).includes(kind));
  if (forbiddenAmount || forbiddenKind) return { verdict: 'wrong-post', detail: `posted ${key(forbiddenAmount || forbiddenKind)}` };
  if (!posted.length) {
    if (!expected.length) return { verdict: (expect.outcomes || []).includes(route) || route === 'no-entry' ? 'correct' : 'stop', detail: route };
    return { verdict: 'stop', detail: route };
  }
  if (JSON.stringify(expected) === JSON.stringify(got)) return { verdict: 'correct', detail: route };
  // هر چه ثبت شد درست بود ولی بخشی جا ماند (مثلاً دریافت بدون طلبِ باقی): ناقص.
  if (got.every((entry) => expected.includes(entry))) return { verdict: 'partial', detail: `missing ${expected.filter((entry) => !got.includes(entry)).join(',')}` };
  return { verdict: 'wrong-post', detail: `expected ${expected.join(',') || '—'} got ${got.join(',')}` };
}

const NON_MONEY = (expect) => (expect.forbid || []).filter((value) => value < 100_000);

async function evaluateNew(event, variant) {
  const { run, aliases } = await freshLedger();
  return run(async () => {
    const startedAt = Date.now();
    const item = await database.createUnderstandingCase({ text: variant.text, clientId: `${event.id}-${variant.style}` }, { fetcher, env, now: NOW });
    const latencyMs = Date.now() - startedAt;
    // نام مسیر همان وضعیت پرونده است، هم‌نام با مسیر قدیمی در گزارش.
    const route = item.status;
    let posted = [];
    let balanced = null;
    let accountsOk = null;
    let roleViolation = false;
    let entries = [];
    if (item.status === 'ready') {
      const committed = database.commitUnderstandingCase(item.id, { now: NOW });
      balanced = accounting.trialBalance(database.activeWorkspaceDatabase()).balanced;
      posted = committed.plan.components.map((component) => [component.kind === 'settlement' ? `settlement-${component.flow}` : KIND_OF_FLOW[component.flow], component.amount, component.accountId]);
      const expectedAccounts = new Map((variant.expect.post || []).map(([kind, amount, alias]) => [key([kind, amount]), alias ? aliases[alias] : null]));
      accountsOk = posted.every((entry) => !expectedAccounts.has(key(entry)) || expectedAccounts.get(key(entry)) === null || expectedAccounts.get(key(entry)) === entry[2]);
      entries = committed.plan.components.map((component) => ({ label: component.label, treatment: component.preview?.treatment || null,
        lines: (component.preview?.lines || []).map((line) => `${line.debit ? 'Dr' : 'Cr'} ${line.role} ${line.debit || line.credit}`) }));
      roleViolation = committed.plan.components.some((component) => (component.preview?.lines || []).some((line) => (variant.expect.forbidRoles || []).includes(line.role)));
    }
    const understanding = item.understanding;
    const amountsExpected = variant.expect.amounts || [];
    const amountsFound = amountsExpected.filter(([value, status]) => understanding?.amounts.some((amount) => amount.accepted && amount.value === value && amount.status === status)).length;
    const fake = (understanding?.amounts || []).filter((amount) => amount.accepted && NON_MONEY(variant.expect).includes(amount.value)).length;
    const datesExpected = variant.expect.dates || [];
    const datesFound = datesExpected.filter(([role, day]) => understanding?.dates.some((date) => date.role === role && date.iso && (() => { const p = todayPersian(new Date(date.iso)); return `${p.year}/${p.month}/${p.day}` === day; })())).length;
    const verdict = judge(variant.expect, posted, { route });
    if (roleViolation) Object.assign(verdict, { verdict: 'wrong-post', detail: 'forbidden role posted' });
    return {
      id: `${event.id}/${variant.style}`, route, verdict: verdict.verdict, detail: verdict.detail, posted,
      questions: (item.plan?.questions || []).map((question) => question.id),
      reasons: item.plan?.reasons || [], error: item.error?.code || null,
      amounts: { expected: amountsExpected.length, found: amountsFound, fake },
      dates: { expected: datesExpected.length, found: datesFound },
      balanced, accountsOk, entries, ai: item.ai, latencyMs,
      violations: item.violations,
    };
  });
}

/**
 * مسیر امروز، به همان ترتیب `routeIntent` در `src/App.jsx`: بی‌مبلغ و چندمبلغی به
 * حسابدار، کارت انتقال بین حساب‌ها، و بعد مسیر `runVoice` (تسویه، نیت‌ها، پارسر و
 * موتور قاعده). فرض بر این است که ثبت‌کننده هر برگه‌ای را که باز شود تأیید می‌کند.
 */
function legacyRoute(text) {
  if (needsUnquantifiedReview(text) || hasCompositeAmounts(text)) return { path: 'accountant-queue', items: [{ outcome: 'accountant' }] };
  const accounts = fixture.ledger.accounts.map((account) => ({ id: account.alias, kind: account.kind, bankId: account.bankId || null, name: account.name, active: true }));
  const transfer = detectCaptureTransfer(text, { accounts, now: NOW });
  if (transfer) {
    const ready = transfer.fromAccountId && transfer.toAccountId;
    return { path: 'transfer', items: [{ outcome: ready ? 'post' : 'ask', amount: transfer.amount, kind: 'transfer' }] };
  }
  return runVoice(text, { today: fixture.now });
}

function evaluateLegacy(event, variant) {
  const startedAt = Date.now();
  const result = legacyRoute(variant.text);
  const posted = result.items.filter((item) => item.outcome === 'post').map((item) => [result.path === 'transfer' ? 'transfer' : LEGACY_KIND[item.kind] || item.kind, item.amount, null]);
  const rows = result.items.map((item) => item.amount).filter(Boolean);
  const route = result.items.some((item) => item.outcome === 'accountant') ? 'needs-accountant'
    : result.items.some((item) => item.outcome === 'ask') ? 'needs-answers'
      : posted.length ? 'ready' : 'no-entry';
  const verdict = judge(variant.expect, posted, { route });
  const nonMoney = NON_MONEY(variant.expect);
  const expectedTotal = (variant.expect.post || []).reduce((sum, [, amount]) => sum + amount, 0);
  const postedTotal = posted.reduce((sum, [, amount]) => sum + amount, 0);
  return {
    id: `${event.id}/${variant.style}`, route, verdict: verdict.verdict, detail: verdict.detail, posted,
    path: result.path, rows, fake: rows.filter((amount) => nonMoney.includes(amount)).length,
    doubleCounted: postedTotal > expectedTotal && expectedTotal > 0, latencyMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// مجموعه‌های قبلی: برگهٔ داوری انسانی
// ---------------------------------------------------------------------------

if (args.set && args.set !== 'acceptance') {
  if (provider !== 'openai') throw new Error('مجموعه‌های قبلی فهمِ دست‌نوشته ندارند؛ فقط با --provider=openai اجرا می‌شوند.');
  let items;
  if (args.set === 'v3') items = JSON.parse(readFileSync(join(root, 'docs/testing/scenarios-30-v3.json'), 'utf8')).map((item) => ({ id: item.id, text: item.text, expected: item.expected }));
  else if (args.set === 'stress40') {
    // فقط کلیدهای جدول EXPECTED — همان ۴۰ سناریویی که رفتارشان قفل شده است.
    const source = readFileSync(join(root, 'test/stress-scenarios.test.js'), 'utf8');
    const block = source.slice(source.indexOf('const EXPECTED = {'), source.indexOf('\n};', source.indexOf('const EXPECTED = {')));
    const ids = [...block.matchAll(/^\s{2}(T\d{3}):/gm)].map((match) => match[1]);
    const all = JSON.parse(readFileSync(join(root, 'test/fixtures/stress-scenarios-v1.json'), 'utf8'));
    items = ids.map((id) => all.find((item) => item.id === id)).filter(Boolean).map((item) => ({ id: item.id, text: item.text, expected: [item.expected, item.debit && `Dr ${item.debit}`, item.credit && `Cr ${item.credit}`].filter(Boolean).join(' · ') }));
  } else throw new Error('set باید acceptance، stress40 یا v3 باشد.');
  const rows = [];
  for (const item of items) {
    if (args.out && rows.length) writeFileSync(`${args.out}.partial.json`, `${JSON.stringify(rows)}
`);
    const { run } = await freshLedger();
    rows.push(await run(async () => {
      const startedAt = Date.now();
      try {
        const result = await database.createUnderstandingCase({ text: item.text, clientId: item.id }, { fetcher, env, now: NOW });
        const lines = (result.plan?.components || []).flatMap((component) => (component.preview?.lines || []).map((line) => `${line.debit ? 'Dr' : 'Cr'} ${line.role} ${line.debit || line.credit}`));
        return { ...item, route: result.status, lines, questions: (result.plan?.questions || []).map((question) => question.text), reasons: result.plan?.reasons || [], notes: (result.plan?.notes || []).map((note) => note.text), error: result.error?.code || null, ai: result.ai, latencyMs: Date.now() - startedAt };
      } catch (error) { return { ...item, route: 'error', error: error.code || error.message, latencyMs: Date.now() - startedAt }; }
    }));
  }
  const out = args.out || join(root, `docs/testing/understanding-review-${args.set}`);
  writeFileSync(`${out}.json`, `${JSON.stringify({ generatedAt: new Date().toISOString(), provider, set: args.set, rows }, null, 2)}\n`);
  writeFileSync(`${out}.md`, [
    `# برگهٔ داوری انسانی — ${args.set} با مسیر تازه`, '', 'ستون «داوری» را حسابدار پر می‌کند: درست / توقف امن / غلط.', '',
    '| شناسه | متن | انتظار | مسیر | سطرهای پیشنهادی | سؤال یا دلیل | داوری |', '|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.id} | ${row.text} | ${row.expected} | ${row.route} | ${(row.lines || []).join(' / ')} | ${[...(row.questions || []), ...(row.reasons || [])].join(' · ').replace(/\|/g, '/')} | |`), '',
  ].join('\n'));
  console.log(JSON.stringify({ set: args.set, rows: rows.length, routes: rows.reduce((acc, row) => ({ ...acc, [row.route]: (acc[row.route] || 0) + 1 }), {}) }, null, 2));
  try { database.closeAllDatabases(); rmSync(scratch, { recursive: true, force: true }); } catch { /* ویندوز */ }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// اجرا و گزارش
// ---------------------------------------------------------------------------

const results = [];
for (const event of fixture.events) {
  for (const variant of event.variants) {
    if (provider === 'oracle' && !variant.oracle) continue;
    try {
      results.push(provider === 'legacy' ? evaluateLegacy(event, variant) : await evaluateNew(event, variant));
    } catch (error) {
      results.push({ id: `${event.id}/${variant.style}`, verdict: 'error', detail: error.message, route: 'error' });
    }
    // نتیجهٔ نیمه‌کاره هم نگه داشته می‌شود: اجرای طولانی با مدل واقعی اگر وسطش قطع شود، کار انجام‌شده گم نمی‌شود.
    if (args.out) writeFileSync(`${args.out}.partial.json`, `${JSON.stringify(results)}
`);
  }
}

const count = (predicate) => results.filter(predicate).length;
const sum = (pick) => results.reduce((total, item) => total + (Number(pick(item)) || 0), 0);
const latencies = results.map((item) => item.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
const summary = {
  provider, utterances: results.length,
  correct: count((item) => item.verdict === 'correct'),
  protectiveStop: count((item) => item.verdict === 'stop'),
  partialPost: count((item) => item.verdict === 'partial'),
  wrongPost: count((item) => item.verdict === 'wrong-post'),
  errors: count((item) => item.verdict === 'error' || item.route === 'failed'),
  routes: Object.fromEntries(['ready', 'needs-answers', 'needs-accountant', 'no-entry', 'failed'].map((route) => [route, count((item) => item.route === route)])),
  fakeAmounts: provider === 'legacy' ? sum((item) => item.fake) : sum((item) => item.amounts?.fake),
  ...(provider === 'legacy' ? { doubleCounted: count((item) => item.doubleCounted) } : {
    amountsFound: `${sum((item) => item.amounts?.found)}/${sum((item) => item.amounts?.expected)}`,
    datesFound: `${sum((item) => item.dates?.found)}/${sum((item) => item.dates?.expected)}`,
    questions: sum((item) => item.questions?.length),
    unbalanced: count((item) => item.balanced === false),
    wrongAccount: count((item) => item.accountsOk === false),
    aiCalls: count((item) => item.ai && !item.ai.cacheHit && item.ai.model),
    tokens: { input: sum((item) => item.ai?.usage?.inputTokens), output: sum((item) => item.ai?.usage?.outputTokens) },
  }),
  latencyMs: latencies.length ? { median: latencies[Math.floor(latencies.length / 2)], max: latencies.at(-1) } : null,
};

const out = args.out || join(root, `docs/testing/understanding-eval-${provider}`);
writeFileSync(`${out}.json`, `${JSON.stringify({ generatedAt: new Date().toISOString(), fixtureVersion: fixture.version, summary, results }, null, 2)}\n`);
const lines = [
  `# ارزیابی فهم رویداد — ${provider}`, '',
  `اجرا: ${new Date().toISOString()} · مجموعه: \`understanding-acceptance-v1\` · ${summary.utterances} گفته`, '',
  '| شاخص | مقدار |', '|---|---|',
  ...Object.entries(summary).filter(([name]) => !['provider', 'utterances'].includes(name)).map(([name, value]) => `| ${name} | ${typeof value === 'object' ? JSON.stringify(value) : value} |`),
  '', '| گفته | مسیر | داوری | جزئیات |', '|---|---|---|---|',
  ...results.map((item) => `| ${item.id} | ${item.route} | ${item.verdict} | ${String(item.detail || '').replace(/\|/g, '/')} |`), '',
];
writeFileSync(`${out}.md`, lines.join('\n'));
console.log(JSON.stringify(summary, null, 2));
try { database.closeAllDatabases(); rmSync(scratch, { recursive: true, force: true }); } catch { /* ویندوز فایل باز را قفل نگه می‌دارد. */ }
