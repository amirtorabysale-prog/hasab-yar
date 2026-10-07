/**
 * اجرای سناریوهای `docs/testing/scenarios-30-v2.json` روی سرور واقعیِ برنامه.
 *
 *   node scripts/scenario-run.mjs <پوشهٔ کار>
 *
 * سرور در همین فرایند با یک پایگاه دادهٔ تازه بالا می‌آید و دفتر «ازمایشی»
 * ساخته می‌شود؛ هر جمله همان راهی را می‌رود که `routeIntent` در `src/App.jsx`
 * می‌رود و از راه HTTP ثبت می‌شود. صاحب کسب‌وکار برگهٔ تأیید را بدون ویرایش
 * تأیید می‌کند و سؤال‌های موتور را با جواب درستِ هر سناریو پاسخ می‌دهد. موارد
 * صف حسابدار با «تحلیل کن» (`/ai-proposal`) بررسی و در صورت امکان ثبت می‌شوند.
 *
 * درخواست به OpenAI رهگیری می‌شود: اگر برای آن سناریو و دور پاسخی در
 * `<پوشهٔ کار>/ai-answers.json` باشد همان برمی‌گردد (جایگزین مدل)، وگرنه متن
 * درخواست در `<پوشهٔ کار>/prompts/` ذخیره و خطای ۵۰۳ برگردانده می‌شود.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const work = process.argv[2];
if (!work) throw new Error('پوشهٔ کار را بده.');
mkdirSync(join(work, 'prompts'), { recursive: true });
const dbPath = join(work, 'run.sqlite');
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
rmSync(join(work, 'workspaces'), { recursive: true, force: true });
// پایگاه داده هر بار تازه است؛ گذرواژهٔ مدیر هم هر بار تصادفی ساخته می‌شود.
Object.assign(process.env, {
  DATABASE_PATH: dbPath, ADMIN_USERNAME: 'scenario-owner', ADMIN_PASSWORD: randomBytes(18).toString('base64url'),
  PORT: '0', NODE_ENV: 'development', OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'stand-in-model',
});

const root = new URL('..', import.meta.url).pathname;
const scenarios = JSON.parse(readFileSync(join(root, 'docs/testing/scenarios-30-v2.json'), 'utf8'));
const answersFile = join(work, 'ai-answers.json');
const aiAnswers = existsSync(answersFile) ? JSON.parse(readFileSync(answersFile, 'utf8')) : {};
const aiCalls = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.openai.com')) return realFetch(url, init);
  const prompt = JSON.parse(init.body).input[0].content[0].text;
  // متن اصلی همین پرونده؛ تجربه‌های DNA جمله‌های سناریوهای دیگر را هم دارند.
  const utterance = JSON.parse(`"${(prompt.match(/"fullUtterance":"((?:[^"\\]|\\.)*)"/) || [])[1] || ''}"`);
  const scenario = scenarios.find((item) => utterance.includes(item.text.slice(0, 30)) || item.text.includes(utterance.slice(0, 30))) || { id: 'unknown' };
  const round = (aiCalls[scenario.id] = (aiCalls[scenario.id] || 0) + 1);
  const key = `${scenario.id}#${round}`;
  writeFileSync(join(work, 'prompts', `${key.replace('#', '-')}.txt`), prompt);
  // شناسهٔ حساب‌های عملیاتی در هر اجرا تازه است؛ پاسخ با نام مستعار نوشته می‌شود.
  const operational = JSON.parse((prompt.match(/"operationalAccounts":(\[[^\]]*\])/) || [])[1] || '[]');
  const alias = { '@cash': 'cash', '@mellat': operational.find((a) => a.bankId === 'mellat')?.id, '@tejarat': operational.find((a) => a.bankId === 'tejarat')?.id };
  const answer = aiAnswers[key] && JSON.parse(JSON.stringify(aiAnswers[key]).replace(/"@(cash|mellat|tejarat)"/g, (_m, name) => JSON.stringify(alias[`@${name}`])));
  if (!answer) return new Response('{}', { status: 503 });
  return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }], usage: {} }), { status: 200 });
};

const { server } = await import(join(root, 'server/index.js'));
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const { parseFinancialText, hasCompositeAmounts } = await import(join(root, 'shared/parser.js'));
const { needsUnquantifiedReview } = await import(join(root, 'shared/reviewIntake.js'));
const { detectCaptureTransfer } = await import(join(root, 'shared/bankSpeech.js'));
const { detectSettleIntent } = await import(join(root, 'shared/settleSpeech.js'));
const { detectVoiceIntent, invoiceDraftPayload, capitalEntryPayload } = await import(join(root, 'shared/voiceIntent.js'));
const { assessTransactionReview } = await import(join(root, 'shared/review.js'));

let cookie = '';
let csrf = '';
let workspaceId = '';
async function call(method, path, body) {
  const response = await realFetch(base + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
  });
  for (const value of response.headers.getSetCookie?.() || []) {
    const [pair] = value.split(';');
    const [name] = pair.split('=');
    cookie = [...cookie.split('; ').filter((item) => item && !item.startsWith(`${name}=`)), pair].join('; ');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`${data.code || response.status}: ${data.message || ''}`), { code: data.code, data });
  return data;
}

// ---- دفتر آزمایشی تازه
const login = await call('POST', '/api/auth/login', { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
csrf = login.csrfToken;
workspaceId = (await call('POST', '/api/workspaces', { name: 'ازمایشی', profileType: 'business' })).workspace.id;
await call('PUT', '/api/workspace/experience', { experience: 'professional' });
await call('POST', '/api/chart/template');
await call('POST', '/api/chart/mappings/suggest', {});
const taxRate = (await call('POST', '/api/tax/rates', { name: 'ارزش افزوده ۱۰٪', rate: 10, treatment: 'taxable', isDefault: true })).item;
await call('POST', '/api/accounts', { name: 'بانک ملت', kind: 'bank', openingBalance: 0 });
await call('POST', '/api/accounts', { name: 'بانک تجارت', kind: 'bank', openingBalance: 0 });
const { policy } = await call('GET', '/api/automation-policy');
const threshold = 20_000_000;
await call('PUT', '/api/automation-policy', { ...policy, engineV2: true, shadowMode: false, capitalizationThreshold: threshold });
const accounts = (await call('GET', '/api/accounts')).items;

async function journalIds() {
  const ids = new Set();
  for (let page = 1; page < 50; page += 1) {
    const result = await call('GET', `/api/accounting/journal?limit=100&page=${page}`);
    for (const item of result.items || []) ids.add(item.id);
    if ((result.items || []).length < 100) break;
  }
  return ids;
}
async function entriesSince(before) {
  const after = await journalIds();
  const fresh = [...after].filter((id) => !before.has(id));
  const entries = [];
  for (const id of fresh) {
    const entry = (await call('GET', `/api/accounting/journal?entryId=${id}`)).items?.[0];
    if (entry) entries.push({ id, memo: entry.memo, lines: entry.lines.map((line) => ({ code: line.chartCode || line.code || '', name: line.chartName || line.name, account: line.name, debit: line.debit, credit: line.credit })) });
  }
  return entries;
}
const events = async () => (await call('GET', '/api/financial-events/review-queue?limit=200')).items || [];

function ownerValue(scenario, fact) {
  const raw = scenario.owner?.[fact];
  if (raw === undefined) return null;
  if (typeof raw === 'string' && raw.startsWith('custom:')) return { value: 'custom', freeText: raw.slice(7) };
  return { value: raw };
}

const results = [];
for (const scenario of scenarios) {
  const text = scenario.text;
  const row = { id: scenario.id, group: scenario.group, text, expected: scenario.expected, steps: [], ownerQuestions: [], errors: [] };
  results.push(row);
  const before = await journalIds();
  const createdTx = [];
  try {
    if (needsUnquantifiedReview(text)) {
      row.path = 'صف حسابدار (بدون مبلغ قطعی)';
      await call('POST', '/api/transactions/unquantified-review', { transcript: text, source: 'voice', clientId: crypto.randomUUID() });
    } else if (hasCompositeAmounts(text)) {
      row.path = 'صف حسابدار (چندمبلغی)';
      await call('POST', '/api/transactions/composite-review', { transcript: text, source: 'voice', clientId: crypto.randomUUID() });
    } else if (detectCaptureTransfer(text, { accounts })) {
      const draft = detectCaptureTransfer(text, { accounts });
      row.path = 'برگهٔ انتقال بین حساب‌ها';
      row.steps.push(`از ${accounts.find((a) => a.id === draft.fromAccountId)?.name} به ${accounts.find((a) => a.id === draft.toAccountId)?.name}، ${draft.amount}`);
      await call('POST', '/api/accounts/transfer', { fromAccountId: draft.fromAccountId, toAccountId: draft.toAccountId, amount: draft.amount, note: text });
    } else if (detectSettleIntent(text)) {
      row.path = 'کارت تسویه (سند باز پیدا نشد → صف حسابدار)';
      await call('POST', '/api/transactions/unmatched-settlement-review', { transcript: text, clientId: crypto.randomUUID() });
    } else if (detectVoiceIntent(text)) {
      const draft = detectVoiceIntent(text);
      row.path = `برگهٔ ${draft.intent}`;
      if (draft.intent === 'invoice') {
        const payload = invoiceDraftPayload(draft, { taxRateId: draft.tax?.wanted ? taxRate.id : null });
        row.steps.push(`فاکتور ${draft.documentType}، طرف: «${draft.contactName}»، مبلغ ${draft.amount}، مالیات ${JSON.stringify(draft.tax || null)}، صدور فوری ${payload?.issueNow}`);
        const { item } = await call('POST', '/api/invoices', { ...payload, documentType: draft.documentType, customerName: draft.contactName || '' });
        row.steps.push(`فاکتور ${item.number} — وضعیت ${item.status}`);
        if (item.status === 'draft') {
          await call('POST', `/api/invoices/${item.id}/issue`, {});
          row.steps.push('پیش‌نویس بود؛ صاحب کسب‌وکار از برگهٔ فاکتورها «صدور» زد');
        }
      } else if (draft.intent === 'cheque') {
        const against = scenario.owner?.chequeAgainst;
        row.ownerQuestions.push(`این چک بابت چیست؟ → ${against === 'income' ? 'بابت فروش یا خرید تازه' : 'بابت طلب یا بدهی قبلی'}`);
        row.steps.push(`چک ${draft.direction}، طرف «${draft.contactName}»، ${draft.amount}، سررسید ${draft.dueAt?.slice(0, 10)}`);
        const { item } = await call('POST', '/api/cheques', { direction: draft.direction, counterpartyName: draft.contactName, amount: draft.amount, against, dueAt: draft.dueAt || null, occurredAt: draft.occurredAt || null, note: text.slice(0, 300) });
        if (item.queuedForAccountant) row.steps.push(`به صف حسابدار: ${item.queuedReason}`);
      } else if (draft.intent === 'capital' || draft.intent === 'fixed-asset') {
        const payload = capitalEntryPayload(draft);
        row.steps.push(`ثبت ${draft.intent}: «${payload.title}»، ${payload.amount}، حساب ${payload.accountId}`);
        await call('POST', '/api/capital-entries', { ...payload, source: 'voice' });
      } else {
        row.steps.push(`تعهد ${draft.direction}: «${draft.title}»، ${draft.amount}`);
        await call('POST', '/api/obligations', { title: draft.title, amount: draft.amount, direction: draft.direction, dueAt: draft.dueAt || null, occurredAt: draft.occurredAt || null, note: text.slice(0, 300) });
      }
    } else {
      const parsed = parseFinancialText(text, { source: 'voice' }).transactions;
      row.path = 'برگهٔ تأیید تراکنش';
      if (!parsed.length) row.steps.push('هیچ ردیفی برداشت نشد');
      const confirmed = parsed.map((item) => {
        const assessment = assessTransactionReview(item);
        row.steps.push(`برداشت: ${item.type === 'income' ? 'دریافت' : 'پرداخت'} ${item.amount}، دسته «${item.category}»${item.contactName ? `، طرف «${item.contactName}»` : ''}${item.bankId ? `، بانک ${item.bankId}` : ''}${item.reviewReasons?.length ? ` — هشدار برگه: ${item.reviewReasons.join(' | ')}` : ''}`);
        return { ...item, userConfirmed: true, needsReview: false, confidence: assessment.overallScore, confidenceDetails: assessment.fields, reviewState: assessment.state === 'ready' ? 'ready' : 'reviewed', reviewReasons: item.reviewReasons || [] };
      });
      if (confirmed.length) {
        const saved = await call('POST', '/api/transactions', { transcript: text, transactions: confirmed, allowDuplicates: true });
        createdTx.push(...(saved.ids || []));
        if (saved.queuedForAccountant) row.steps.push(`ردیف نقدی ساخته نشد؛ صف حسابدار: ${(saved.queuedReasons || []).join(' | ')}`);
      }
    }
  } catch (error) { row.errors.push(`ثبت: ${error.message}`); }

  // ---- صاحب کسب‌وکار: سؤال موتور و تأیید
  for (let guard = 0; guard < 6; guard += 1) {
    const mine = (await events()).filter((item) => createdTx.some((id) => item.sourceEventId === `transaction:${id}`) || String(item.event?.evidence || item.event?.utterance || '').includes(text.slice(0, 25)));
    const pending = mine.filter((item) => item.route !== 'accountant-review');
    if (!pending.length) break;
    const item = pending[0];
    try {
      const { decision } = await call('GET', `/api/financial-events/${item.id}/decision`);
      if (decision?.decisionStatus === 'needs-user-input' && decision.question) {
        const answer = ownerValue(scenario, decision.question.fact);
        if (!answer) {
          row.ownerQuestions.push(`«${decision.question.text}» — جواب سناریو تعریف نشده؛ به حسابدار سپرده شد`);
          await call('POST', `/api/financial-events/${item.id}/reject`, { reason: 'unused' }).catch(() => {});
          break;
        }
        const label = decision.question.options?.find((option) => option.value === answer.value)?.label || answer.freeText || answer.value;
        row.ownerQuestions.push(`«${decision.question.text}» → ${label}`);
        const { item: answered } = await call('POST', `/api/financial-events/${item.id}/answer`, { fact: decision.question.fact, ...answer });
        if (answered.route === 'accountant-review') { row.steps.push(`پس از جواب به صف حسابدار رفت: ${answered.decision?.explanation || ''}`); }
        continue;
      }
      await call('POST', `/api/financial-events/${item.id}/approve`, {});
      row.steps.push('صاحب کسب‌وکار «تأیید» زد');
    } catch (error) { row.errors.push(`تأیید: ${error.message}`); break; }
  }
  row.ownerEntries = await entriesSince(before);
  const queued = (await events()).filter((item) => item.route === 'accountant-review'
    && (createdTx.some((id) => item.sourceEventId === `transaction:${id}`) || String(item.event?.evidence || item.event?.utterance || '').includes(text.slice(0, 25))));
  row.queue = queued.map((item) => ({ id: item.id, amount: item.amount, kind: item.kind, reasons: item.confidence?.reasons || [] }));
}

const truthAccount = (scenario) => (/ملت/.test(scenario.text) ? accounts.find((a) => a.bankId === 'mellat')
  : /تجارت/.test(scenario.text) ? accounts.find((a) => a.bankId === 'tejarat') : accounts.find((a) => a.id === 'cash'))?.id;

// ---- صف حسابدار: «تحلیل کن» تا سند نهایی
for (const row of results) {
  const scenario = scenarios.find((item) => item.id === row.id);
  row.ai = [];
  for (const queued of row.queue) {
    const trail = { eventId: queued.id, rounds: [] };
    row.ai.push(trail);
    const before = await journalIds();
    const answers = {};
    try {
      for (let round = 1; round <= 4; round += 1) {
        const { proposal } = await call('POST', `/api/financial-events/${queued.id}/ai-proposal`, { facts: { questionAnswers: answers } });
        trail.rounds.push({
          source: proposal.analysisCost?.source || proposal.model, model: proposal.model, summary: proposal.summary, explanation: proposal.explanation,
          lines: (proposal.lines || []).map((line) => ({ role: line.role, key: line.key, debit: line.debit, credit: line.credit })),
          questions: (proposal.questions || []).map((q) => ({ id: q.id, text: q.text, field: q.field || null })), canPost: proposal.canPost, blockers: proposal.workflowBlockers || [],
        });
        const open = (proposal.questions || []).filter((q) => !(q.id in answers));
        if (open.length) {
          let answeredAny = false;
          for (const q of open) {
            // بانک یا صندوق از خود جمله معلوم است؛ همان را انتخابگر حساب می‌گذارد.
            const value = q.field === 'accountId' ? truthAccount(scenario) : scenario.accountant?.[q.id];
            if (value !== undefined) { answers[q.id] = { value }; answeredAny = true; }
          }
          if (!answeredAny) { trail.stoppedAt = 'سؤال بی‌جواب در سناریو — بعداً از صاحب دفتر پرسیده شود'; break; }
          continue;
        }
        if (!(proposal.lines || []).length) { trail.stoppedAt = 'پیشنهاد بدون سطر'; break; }
        const accepted = await call('POST', `/api/financial-events/${queued.id}/ai-feedback`, { proposalId: proposal.id, accepted: true });
        trail.accepted = Boolean(accepted.item?.journalEntryId || accepted.item?.status === 'posted');
        if (!trail.accepted) trail.stoppedAt = `اعمال پیشنهاد سند نزد: ${JSON.stringify(accepted).slice(0, 300)}`;
        break;
      }
    } catch (error) { trail.error = error.message; }
    trail.entries = await entriesSince(before);
  }
}

const balance = await call('GET', '/api/accounting/trial-balance').catch((error) => ({ error: error.message }));

// ---- تطبیق: اثر نقدی هر ردیف تراکنش (مبنای موجودی صندوق و بانک در برنامه) با
// سطرهای صندوق/بانک سندهایی که برای همان ردیف خورده است.
const { DatabaseSync } = await import('node:sqlite');
const ledgerDb = new DatabaseSync(join(work, 'workspaces', `${workspaceId}.sqlite`));
const reconciliation = [];
for (const tx of ledgerDb.prepare('SELECT id,raw_text AS text,type,amount FROM transactions ORDER BY created_at').all()) {
  const rowEffect = (tx.type === 'income' ? 1 : -1) * tx.amount;
  const event = ledgerDb.prepare('SELECT status,route,journal_entry_id AS entryId FROM financial_events WHERE source_event_id=?').get(`transaction:${tx.id}`);
  const entries = new Set(ledgerDb.prepare('SELECT id FROM journal_entries WHERE source_id=?').all(tx.id).map((item) => item.id));
  if (event?.entryId) entries.add(event.entryId);
  let ledgerEffect = 0;
  for (const id of entries) ledgerEffect += ledgerDb.prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS v FROM journal_lines l
    JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=? AND a.source_kind='operational-account'`).get(id).v;
  const scenario = scenarios.find((item) => String(tx.text).includes(item.text.slice(0, 25)) || item.text.includes(String(tx.text).slice(0, 25)));
  if (rowEffect !== ledgerEffect) reconciliation.push({ id: scenario?.id, row: rowEffect, ledger: ledgerEffect, event: event ? `${event.status}/${event.route}` : null });
}
ledgerDb.close();
writeFileSync(join(work, 'results.json'), JSON.stringify({ threshold, results, trialBalance: balance, reconciliation }, null, 1));
console.log(`نتیجه در ${join(work, 'results.json')}`);
server.close();
process.exit(0);
