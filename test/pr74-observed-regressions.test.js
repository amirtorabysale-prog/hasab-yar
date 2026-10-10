import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFinancialText } from '../shared/parser.js';
import { extractDateMention, extractOccurrenceDate, todayPersian } from '../shared/persianDate.js';
import { detectSettleIntent } from '../shared/settleSpeech.js';
import { extractContactCandidate, extractContactName } from '../shared/counterpartySpeech.js';
import { needsUnquantifiedReview } from '../shared/reviewIntake.js';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
const cases = new Map(JSON.parse(fs.readFileSync(new URL('./fixtures/stress-scenarios-v1.json', import.meta.url))).map(s => [s.id,s.text]));
const now = new Date('2026-09-30T08:30:00Z');
const parse = id => parseFinancialText(cases.get(id), { now });
process.env.DATABASE_PATH = tempDatabase('observed-pr74');
process.env.ADMIN_USERNAME = 'observed-owner';
process.env.ADMIN_PASSWORD = `observed-${crypto.randomUUID()}`;
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const run = fn => database.runInWorkspace('primary', { overdraftApproval: FIXTURE_OVERDRAFT, role:'owner', userId:owner.id }, fn);

test('T002/T031/T050: service, original purchase and future cashing do not set payment date', () => {
  for (const id of ['T002','T031','T050']) {
    assert.equal(extractOccurrenceDate(cases.get(id), {now}), null, id);
    for (const item of parse(id).transactions) assert.ok(!item.occurredAt, id);
    assert.equal(extractOccurrenceDate(`امروز ${cases.get(id)}`, {now}).label, 'امروز');
  }
  const insurance = parse('T002').transactions[0];
  assert.ok(insurance.servicePeriodStart && insurance.servicePeriodEnd);
  assert.equal(detectSettleIntent(cases.get('T031'), {now})?.occurredAt ?? null, null);
  assert.equal(extractOccurrenceDate('دیروز ده میلیون اجاره پرداخت کردم', {now}).label, 'دیروز');
});
test('T041: fifteenth next month is fifteenth, not current day; duration remains calendar offset', () => {
  const result = extractDateMention(cases.get('T041'), {now, preferPast:false});
  assert.deepEqual(todayPersian(new Date(result.iso)), {year:1405,month:8,day:15});
  const duration = extractDateMention('یک ماه بعد', {now, preferPast:false});
  assert.deepEqual(todayPersian(new Date(duration.iso)), {year:1405,month:8,day:8});
});
test('T055/T068/T079/T103: amounts and verbs are never names; real compound company remains intact', () => {
  for(const id of ['T055','T068','T079','T103']) assert.equal(extractContactCandidate(cases.get(id)).name, '', id);
  for(const text of ['شرکت عودت داد','شد، مبلغ ده میلیون','به مبلغ ده میلیون']) assert.equal(extractContactName(text,{allowBare:true}),'');
  assert.equal(extractContactName('به شرکت آراد گستر آسیا، پنج میلیون پرداخت شد'), 'شرکت آراد گستر آسیا');
  assert.equal(extractContactName('خانم دکتر افشار شریک شرکت، ده میلیون داد'), 'افشار');
});
test('T106: prior-year depreciation adjustment must not classify as payroll', () => {
  assert.notEqual(parse('T106').transactions[0].category, 'حقوق و دستمزد');
  assert.equal(parseFinancialText('نود میلیون سنوات کارکنان پرداخت شد').transactions[0].category, 'حقوق و دستمزد');
});
test('T025: mixed card/credit has truthful reason and creates no cash or journal', () => run(() => {
  const db = database.activeWorkspaceDatabase();
  const before = db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  const journal = db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  const ids = database.insertTransactions({transcript:cases.get('T025'), transactions:parse('T025').transactions.map(x=>({...x,clientId:'t025',accountId:'cash'}))});
  assert.equal(ids.queuedForAccountant, 1);
  assert.match(ids.queuedReasons[0], /بخشی از وجه پرداخت شده/);
  assert.doesNotMatch(ids.queuedReasons[0], /وجهی جابه‌جا نشده/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n,journal);
}));
test('T001: confirmed preview posts once; confirmation never bypasses ambiguity', () => run(() => {
  const db=database.activeWorkspaceDatabase();
  database.saveAutomationPolicy({...database.automationPolicy(), engineV2:true, shadowMode:false});
  const bank=database.saveAccount({name:'بانک سامان',kind:'bank',bankId:'saman'});
  const item={...parse('T001').transactions[0],accountId:bank.id,clientId:'t001-confirmed',userConfirmed:true,reviewState:'reviewed',needsReview:false};
  const ids=database.insertTransactions({transcript:cases.get('T001'),transactions:[item]});
  const event=db.prepare('SELECT status FROM financial_events WHERE source_event_id=?').get(`transaction:${ids[0]}`);
  assert.equal(event.status,'posted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type='transaction' AND source_id=?").get(ids[0]).n,1);
  database.insertTransactions({transcript:cases.get('T001'),transactions:[item]});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type='transaction' AND source_id=?").get(ids[0]).n,1);
  const unsafe={...item,clientId:'unsafe-confirmed',rawText:'هفت میلیون هزینه نامعلوم',amount:7000000,category:'سایر هزینه‌ها',reviewReasons:['ماهیت هزینه مشخص نیست']};
  const held=database.insertTransactions({transcript:unsafe.rawText,transactions:[unsafe]});
  assert.equal(db.prepare('SELECT status FROM financial_events WHERE source_event_id=?').get(`transaction:${held[0]}`).status,'pending');
}));
test('T109/T040/T100: persistent, idempotent unquantified cases without invented amount; auditable resolution', () => run(() => {
  const db=database.activeWorkspaceDatabase();
  const n=db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  for(const id of ['T109','T040','T100']) {
    assert.equal(needsUnquantifiedReview(cases.get(id)),true);
    const item=database.queueUnquantifiedReview(cases.get(id),{clientId:id});
    assert.equal(item.amount,null);
    assert.equal(database.queueUnquantifiedReview(cases.get(id),{clientId:id}).id,item.id);
    assert.ok(database.reviewQueue().items.some(x=>x.id===item.id));
    assert.throws(()=>database.approveEvent(item.id));
    assert.throws(()=>database.resolveUnquantifiedReview(item.id,{reason:'کوتاه'}));
    database.resolveUnquantifiedReview(item.id,{reason:'پس از بررسی نیازی به سند اصلاحی نیست'});
    assert.ok(!database.reviewQueue().items.some(x=>x.id===item.id));
    assert.equal(db.prepare('SELECT status FROM accountant_intakes WHERE id=?').get(item.id).status,'resolved');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n,n);
  assert.throws(()=>database.queueUnquantifiedReview('سلام، خوبی؟'));
  assert.throws(()=>database.queueUnquantifiedReview('ده میلیون اصلاحش کن'));
  assert.ok(database.financialBackupSnapshot().tables.accountant_intakes.length>=3);
}));
test('chart install prepares active posting accounts once without generating journals', () => run(() => {
  const db=database.activeWorkspaceDatabase();
  const before=db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
  const chart=database.installChartTemplate();
  for(const account of chart.accounts.filter(x=>x.active&&x.postable)) {
    assert.ok(db.prepare('SELECT id FROM ledger_accounts WHERE chart_account_id=? AND active=1').get(account.id),account.name);
  }
  const n=db.prepare('SELECT COUNT(*) n FROM ledger_accounts').get().n;
  database.installChartTemplate();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_accounts').get().n,n);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n,before);
}));
