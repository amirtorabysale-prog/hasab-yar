import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * مجموعهٔ پذیرش فهم رویداد — بیان رسمی هر رویداد، با فهمِ درستِ دست‌نوشته.
 *
 * این آزمون دقت مدل را نمی‌سنجد؛ قفل می‌کند که اگر فهم درست باشد، اعتبارسنجی،
 * تبدیل، موتور قاعده و ثبت همان سند درست را می‌سازند و هیچ‌وقت سند غلط یا ناقص
 * نمی‌زنند. دقتِ مدل واقعی با `scripts/understanding-eval.mjs --provider=openai`
 * روی محیط آزمایشی سنجیده می‌شود.
 */

const fixture = JSON.parse(readFileSync(new URL('../docs/testing/understanding-acceptance-v1.json', import.meta.url), 'utf8'));
const NOW = new Date(fixture.now);
const oracleOf = (value) => (typeof value === 'string' ? JSON.parse(readFileSync(new URL(`./fixtures/${value.slice('fixture:'.length)}`, import.meta.url), 'utf8')) : value);
const oracles = new Map([...fixture.ledger.seed.map((seed) => [seed.text, seed.understanding]),
  ...fixture.events.flatMap((event) => event.variants.filter((variant) => variant.oracle).map((variant) => [variant.text, oracleOf(variant.oracle)]))]);
const fetcher = async (_url, init) => {
  const said = JSON.parse(JSON.parse(init.body).input[1].content[0].text)['گفتهٔ کاربر'];
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(oracles.get(said)) }] }], usage: {} }) };
};
const env = { OPENAI_API_KEY: 'oracle', OPENAI_UNDERSTANDING_MODEL: 'oracle' };

const databasePath = tempDatabase('understanding-acceptance');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'acceptance-owner';
process.env.ADMIN_PASSWORD = 'acceptance-strong-password-3381';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('acceptance-owner', 'acceptance-strong-password-3381');

async function freshLedger(name) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  const run = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
  const aliases = {};
  await run(async () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all', capitalizationThreshold: fixture.ledger.capitalizationThreshold });
    for (const account of fixture.ledger.accounts) aliases[account.alias] = database.saveAccount({ ...(account.id ? { id: account.id } : {}), name: account.name, kind: account.kind, bankId: account.bankId, openingBalance: account.openingBalance }).id;
    for (const contact of fixture.ledger.contacts) database.saveContact({ name: contact });
    for (const seed of fixture.ledger.seed) {
      const item = await database.createUnderstandingCase({ text: seed.text, clientId: 'seed' }, { fetcher, env, now: NOW });
      database.commitUnderstandingCase(item.id, { now: NOW });
    }
  });
  return { run, aliases };
}

const KIND = { out: 'cash-out', in: 'cash-in', payable: 'obligation-payable', receivable: 'obligation-receivable', transfer: 'transfer' };
// دو رویدادی که قاعدهٔ مصوبِ امروز عمداً متوقفشان می‌کند: قبضِ بی‌نامِ طرف حساب
// (موتور می‌پرسد از کیست) و دارایی ثابتِ بالای حد سرمایه‌ای (با حسابدار).
const STOPS = { E06: 'needs-answers', E07: 'needs-accountant' };

for (const event of fixture.events) {
  const variant = event.variants.find((item) => item.oracle);
  test(`${event.id} — ${event.title}`, async () => {
    const { run, aliases } = await freshLedger(`پذیرش ${event.id}`);
    await run(async () => {
      const item = await database.createUnderstandingCase({ text: variant.text, clientId: event.id }, { fetcher, env, now: NOW });
      if (STOPS[event.id]) {
        assert.equal(item.status, STOPS[event.id], JSON.stringify(item.plan));
        assert.equal(database.listTransactions({}).items.filter((row) => row.rawText === variant.text).length, 0, 'بدون سند');
        return;
      }
      assert.equal(item.status, 'ready', JSON.stringify(item.plan));
      for (const [value, status] of variant.expect.amounts || []) {
        assert.ok(item.understanding.amounts.some((amount) => amount.accepted && amount.value === value && amount.status === status), `${value} ${status}`);
      }
      const committed = database.commitUnderstandingCase(item.id, { now: NOW });
      assert.equal(accounting.trialBalance(database.activeWorkspaceDatabase()).balanced, true);
      const posted = committed.plan.components.map((component) => [component.kind === 'settlement' ? `settlement-${component.flow}` : KIND[component.flow], component.amount, component.accountId]);
      const expected = variant.expect.post.map(([kind, amount, alias]) => [kind, amount, alias ? aliases[alias] : null]);
      assert.deepEqual(posted.map(([kind, amount]) => `${kind}:${amount}`).sort(), expected.map(([kind, amount]) => `${kind}:${amount}`).sort());
      for (const [kind, amount, account] of expected) {
        if (account) assert.equal(posted.find((entry) => entry[0] === kind && entry[1] === amount)[2], account, `${kind} ${amount}`);
      }
      for (const forbidden of variant.expect.forbid || []) assert.ok(!posted.some(([, amount]) => amount === forbidden), `${forbidden} نباید ثبت شود`);
    });
  });
}

test.after(() => removeTempDatabase(databasePath));
