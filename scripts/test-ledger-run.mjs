/**
 * اجرای زندهٔ آزمون روی دفتر «ازمایشی» — هرگز دفتر اصلی.
 *
 *   BASE_URL=https://… HY_USER=… HY_PASS=… node scripts/test-ledger-run.mjs
 *
 * همان مسیر برنامه از راه HTTP: کدینگ و نگاشت، فاکتور خرید با ارزش افزوده،
 * طلب استرداد، T076 در صف حسابدار، و سپس ۴۰ سناریو. اگر دفتری با نام
 * «ازمایشی» نباشد ساخته می‌شود؛ اگر نام دفتر فعال آن نباشد، اسکریپت متوقف
 * می‌شود.
 */
import { readFileSync } from 'node:fs';
import { runVoice } from '../test/helpers/voicePipeline.js';
import { parseFinancialText } from '../shared/parser.js';

const base = String(process.env.BASE_URL || '').replace(/\/$/, '');
const ledgerName = process.env.HY_LEDGER || 'ازمایشی';
if (!/^https?:\/\//.test(base) || !process.env.HY_USER || !process.env.HY_PASS) throw new Error('BASE_URL، HY_USER و HY_PASS لازم است.');

let cookie = '';
let csrf = '';
let workspaceId = '';
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const value of response.headers.getSetCookie?.() || []) {
    const [pair] = value.split(';');
    const [name] = pair.split('=');
    cookie = [...cookie.split('; ').filter((item) => item && !item.startsWith(`${name}=`)), pair].join('; ');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} → ${response.status} ${data.code || ''} ${data.message || ''}`), { data, status: response.status });
  return data;
}
const log = (...parts) => console.log(...parts);
const fa = (n) => Number(n || 0).toLocaleString('en-US');

// ---- ورود و دفتر آزمایشی
const login = await call('POST', '/api/auth/login', { username: process.env.HY_USER, password: process.env.HY_PASS });
csrf = login.csrfToken;
let ledger = login.workspaces.find((item) => item.name.trim() === ledgerName);
if (!ledger) ledger = (await call('POST', '/api/workspaces', { name: ledgerName, profileType: 'business' })).workspace;
workspaceId = ledger.id;
// کدینگ و صف حسابدار ابزار محیط حرفه‌ای‌اند؛ فقط در همین دفتر آزمایشی عوض می‌شود.
await call('PUT', '/api/workspace/experience', { experience: 'professional' });
// معیار پذیرش ۴۰ سناریو با موتور تصمیم نسخهٔ دو تعریف شده؛ فلگ سطح دفتر است
// و فقط در همین دفتر آزمایشی روشن می‌شود. بقیهٔ سیاست دفتر دست نمی‌خورد.
const { policy } = await call('GET', '/api/automation-policy');
if (!policy.engineV2) await call('PUT', '/api/automation-policy', { ...policy, engineV2: true });
log(`موتور تصمیم نسخهٔ دو: ${policy.engineV2 ? 'از قبل روشن' : 'در دفتر آزمایشی روشن شد'}`);
const access = await call('GET', '/api/workspaces');
if (access.workspace?.id !== ledger.id || access.workspace.name.trim() !== ledgerName) throw new Error('دفتر فعال «ازمایشی» نیست؛ متوقف شد.');
log(`دفتر: ${access.workspace.name} (${ledger.id}) — نقش ${access.workspace.role}، تجربه ${access.experience}`);
const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => ({}));
log(`نسخه: ${health.release?.sha || 'نامشخص'}`);

// ---- ۱. کدینگ و نگاشت
const chart = await call('POST', '/api/chart/template');
log('نصب کدینگ:', JSON.stringify(chart).slice(0, 200));
const mapped = await call('POST', '/api/chart/mappings/suggest', {});
log('نگاشت پیشنهادی:', `اعمال ${mapped.applied ?? '?'}، اصلاح ${mapped.refined ?? '?'}`);

// ---- ۲. فاکتور خرید با ارزش افزوده
const tag = new Date().toISOString().slice(0, 16);
const created = await call('POST', '/api/invoices', {
  documentType: 'purchase', customerName: `تأمین‌کنندهٔ آزمون ${tag}`, tax: 1_000_000,
  items: [{ title: 'مواد آزمون استرداد', quantity: 1, unitPrice: 10_000_000 }],
});
await call('POST', `/api/invoices/${created.item.id}/issue`, {});
let report = await call('GET', '/api/tax/report');
log(`فاکتور خرید ثبت شد. مانده: فروش ${fa(report.ledger.outputTax)}، خرید ${fa(report.ledger.inputTax)}، قابل استرداد ${fa(report.ledger.refundClaimable)}`);

// ---- ۳. طلب استرداد
const claimAmount = Math.min(10_000_000, report.ledger.refundClaimable);
if (claimAmount <= 0) throw new Error('ماندهٔ قابل استرداد صفر است.');
const claim = (await call('POST', '/api/tax/vat-refund-claim', { amount: claimAmount, reference: `آزمون-${tag}` })).item;
log(`طلب استرداد: ${fa(claim.amount)} (اعتبار خرید ${fa(claim.fromInput)}، اضافه‌پرداخت ${fa(claim.fromOverpayment)}) — سند ${claim.fiscalYear}/${claim.documentNumber}`);

// ---- ۴. T076 در صف حسابدار
const scenarios = JSON.parse(readFileSync(new URL('../test/fixtures/stress-scenarios-v1.json', import.meta.url), 'utf8'));
const t076 = scenarios.find((item) => item.id === 'T076').text.replace('ده میلیون', `${claimAmount / 1_000_000} میلیون`);
const accounts = (await call('GET', '/api/accounts')).items;
const bank = accounts.find((item) => item.kind === 'bank') || accounts[0];
const parsed = parseFinancialText(t076, { source: 'text' }).transactions.map((item) => ({ ...item, accountId: bank.id }));
const saved = await call('POST', '/api/transactions', { transcript: t076, transactions: parsed, allowDuplicates: true });
log(`T076 فرستاده شد: صف حسابدار ${saved.queuedForAccountant}`);
const queue = await call('GET', '/api/financial-events/review-queue?limit=50');
const event = (queue.items || []).find((item) => String(item.event?.evidence || '').includes('عودت') && item.status === 'pending');
if (!event) throw new Error('رویداد T076 در صف حسابدار پیدا نشد.');
let proposal = await call('POST', `/api/financial-events/${event.id}/ai-proposal`, { facts: { accountId: bank.id } });
proposal = proposal.proposal || proposal;
log('پیشنهاد:', proposal.summary, '|', (proposal.questions || []).map((q) => q.text).join(' / ') || 'بدون سؤال');
if ((proposal.questions || []).some((q) => q.id === 'nature.vat-refund')) {
  proposal = await call('POST', `/api/financial-events/${event.id}/ai-proposal`, {
    facts: { accountId: bank.id, questionAnswers: { 'nature.vat-refund': { value: `${claim.fiscalYear}/${claim.documentNumber}` } } },
  });
  proposal = proposal.proposal || proposal;
  log('پس از پاسخ:', proposal.summary, '|', (proposal.questions || []).map((q) => q.text).join(' / ') || 'بدون سؤال');
}
const posted = (await call('POST', `/api/financial-events/${event.id}/ai-feedback`, { proposalId: proposal.id, accepted: true })).item;
const journal = await call('GET', `/api/accounting/journal?entryId=${posted.journalEntryId}`);
const entry = (journal.items || [])[0];
log('سند T076:');
const describe = (line) => `${line.debit ? 'Dr' : 'Cr'} ${line.chartCode || line.code} ${line.chartName || line.name} ${fa(line.debit || line.credit)}`;
for (const line of entry?.lines || []) log(`  ${describe(line)}`);
// درآمد در کدینگ قالب گروه ۶ است.
const income = (entry?.lines || []).some((line) => String(line.chartCode || '').startsWith('6'));
log(income ? '✗ درآمد ساخته شد' : '✓ بدون درآمد');
report = await call('GET', '/api/tax/report');
log(`پس از وصول: قابل استرداد ${fa(report.ledger.refundClaimable)}`);

// ---- ۵. چهل سناریو
const SCOPE = ['T001', 'T002', 'T004', 'T006', 'T008', 'T009', 'T010', 'T016', 'T062', 'T055', 'T068', 'T031', 'T032', 'T033', 'T035',
  'T023', 'T041', 'T042', 'T050', 'T099', 'T025', 'T071', 'T073', 'T074', 'T076', 'T079', 'T081', 'T082', 'T083',
  'T090', 'T101', 'T102', 'T103', 'T106', 'T108', 'T109', 'T037', 'T040', 'T100', 'T120'];
const rows = [];
const createdRows = new Map();
for (const id of SCOPE) {
  const { text } = scenarios.find((item) => item.id === id);
  const local = runVoice(text);
  let server = '';
  try {
    if (local.path === 'composite-review') {
      await call('POST', '/api/transactions/composite-review', { transcript: text, source: 'text', clientId: crypto.randomUUID() });
      server = 'صف (یک پرونده)';
    } else if (['transaction', 'queued'].includes(local.path)) {
      const items = parseFinancialText(text, { source: 'text' }).transactions.map((item) => ({ ...item, accountId: item.accountId || bank.id }));
      if (!items.length) server = 'بدون ردیف';
      else {
        const result = await call('POST', '/api/transactions', { transcript: text, transactions: items, allowDuplicates: true });
        createdRows.set(id, result.ids || []);
        server = result.queuedForAccountant ? `صف حسابدار (بدون ردیف نقدی)` : '';
      }
    } else server = 'کارت پرسش (بدون ثبت)';
  } catch (error) { server = `خطا: ${error.message}`; }
  rows.push({ id, outcome: local.items.map((item) => item.outcome + (item.fact ? `:${item.fact}` : '')).join(',') || 'none', server });
}
// هر ردیف ساخته‌شده کجا نشست: صف حسابدار، تأیید کاربر، یا ثبت خودکار.
const pending = (await call('GET', '/api/financial-events/review-queue?limit=500')).items || [];
const recent = (await call('GET', '/api/accounting/journal?limit=100')).items || [];
for (const row of rows) {
  if (row.server) continue;
  row.server = (createdRows.get(row.id) || []).map((txId) => {
    const queued = pending.find((item) => item.sourceEventId === `transaction:${txId}`);
    if (queued) return queued.route === 'accountant-review' ? 'صف حسابدار' : `تأیید کاربر (${queued.route})`;
    const entry = recent.find((item) => item.sourceId === txId || String(item.sourceId || '').includes(txId));
    return entry ? `ثبت: ${entry.lines.map(describe).join(' / ')}` : 'ثبت (سند پیدا نشد)';
  }).join(' | ');
}
console.table(rows);
