import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('batch');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'batch-owner';
process.env.ADMIN_PASSWORD = 'Ledger-Long-Passphrase-8812';

const database = await import(`../server/db.js?batch=${process.pid}`);
const accounting = await import(`../server/accounting.js?batch=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('batch-owner', 'Ledger-Long-Passphrase-8812');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت ثبت انبوه', profileType: 'business' });
// کنترل‌کننده باید عضو واقعی دفتر باشد، وگرنه آزمون تفکیک ثبت/کنترل روی دفتری
// اجرا می‌شود که اصلاً کنترل‌کنندهٔ دومی ندارد و خودتأییدی در آن مجاز است.
const reviewerId = database.addWorkspaceMember(workspace.id, {
  username: 'batch-reviewer', displayName: 'کنترل‌کننده', role: 'manager',
  temporaryPassword: 'Reviewer-Long-Passphrase-4471',
}).id;
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const reviewInWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'manager', userId: reviewerId }, callback);

// اسناد باید داخل دورهٔ شمسی جاری بنشینند، وگرنه کنترل‌های دوره‌ای آن‌ها را نمی‌بینند.
const AT = new Date().toISOString();
let cash;
let income;
let batchIds = [];

function twoLines(amount) {
  return [
    { accountId: cash.id, debit: amount, description: 'دریافت' },
    { accountId: income.id, credit: amount, description: 'فروش' },
  ];
}

test('every automatic document gets a sequential number in its fiscal year', () => {
  inWorkspace(() => {
    database.insertTransactions({
      transcript: 'فروش اول',
      transactions: [{ amount: 1_000_000, type: 'income', category: 'فروش', rawText: 'فروش اول', occurredAt: AT }],
    });
    database.insertTransactions({
      transcript: 'فروش دوم',
      transactions: [{ amount: 2_000_000, type: 'income', category: 'فروش', rawText: 'فروش دوم', occurredAt: AT }],
    });
    const journal = accounting.listJournal(database.db, { limit: 100 });
    const numbers = journal.items.map((item) => item.documentNumber).filter(Boolean).sort((a, b) => a - b);
    assert.ok(numbers.length >= 2);
    // بدون گپ: دنبالهٔ ۱..n
    assert.deepEqual(numbers, numbers.map((_value, index) => index + 1));
    assert.ok(journal.items.every((item) => item.fiscalYear && item.fiscalYear.length === 4));
  });
});

test('documents posted by the system are already approved so nothing freezes', () => {
  inWorkspace(() => {
    const journal = accounting.listJournal(database.db, { limit: 100 });
    assert.ok(journal.items.every((item) => item.approvalState === 'approved'));
    assert.equal(journal.items[0].approvalLabel, 'کنترل‌شده');
    assert.equal(database.journalWorklistOverview().summary.clear, true);
  });
});

test('a bulk post writes many documents in one go, all as drafts', () => {
  inWorkspace(() => {
    const accounts = accounting.listLedgerAccounts(database.db);
    cash = accounts.find((item) => item.type === 'asset');
    income = accounts.find((item) => item.type === 'income');

    const beforeBalance = accounting.trialBalance(database.db);
    const result = database.createJournalDocuments([
      { occurredAt: AT, memo: 'سند دستی ۱', lines: twoLines(500_000) },
      { occurredAt: AT, memo: 'سند دستی ۲', lines: twoLines(700_000) },
      { occurredAt: AT, memo: 'سند دستی ۳', lines: twoLines(900_000) },
    ]);
    batchIds = result.entryIds;
    assert.equal(result.created, 3);
    assert.equal(result.total, 2_100_000);
    // شماره‌ها پشت سر هم و بدون گپ ادامه پیدا می‌کنند.
    const [first, second, third] = result.documentNumbers;
    assert.equal(second, first + 1);
    assert.equal(third, second + 1);

    const worklist = database.journalWorklistOverview();
    assert.equal(worklist.summary.draft, 3);
    assert.equal(worklist.summary.clear, false);
    const afterBalance = accounting.trialBalance(database.db);
    assert.equal(afterBalance.balanced, true);
    assert.deepEqual(afterBalance.totals, beforeBalance.totals, 'پیش‌نویس نباید وارد تراز قطعی شود');
  });
});

test('one bad document cancels the whole batch and consumes no numbers', () => {
  inWorkspace(() => {
    const before = accounting.listJournal(database.db, { limit: 100 }).total;
    assert.throws(() => database.createJournalDocuments([
      { occurredAt: AT, memo: 'خوب', lines: twoLines(100_000) },
      { occurredAt: AT, memo: 'نامتوازن', lines: [{ accountId: cash.id, debit: 100 }, { accountId: income.id, credit: 90 }] },
    ]), (error) => error.code === 'JOURNAL_BATCH_INVALID' && error.details.errors[0].position === 2);

    assert.equal(accounting.listJournal(database.db, { limit: 100 }).total, before, 'سند خوبِ همان دسته هم نباید ثبت شود');
    const numbers = accounting.listJournal(database.db, { limit: 100 }).items.map((item) => item.documentNumber).sort((a, b) => a - b);
    assert.deepEqual(numbers, numbers.map((_value, index) => index + 1), 'دنبالهٔ شماره نباید گپ بگیرد');
  });
});

test('an empty or oversized batch is refused before touching the ledger', () => {
  inWorkspace(() => {
    assert.throws(() => database.createJournalDocuments([]), (error) => error.code === 'JOURNAL_BATCH_EMPTY');
    assert.throws(
      () => database.createJournalDocuments(Array.from({ length: 201 }, () => ({ occurredAt: AT, lines: twoLines(1_000) }))),
      (error) => error.code === 'JOURNAL_BATCH_TOO_LARGE',
    );
  });
});

test('a client-supplied approved state is ignored for every manual batch', () => {
  inWorkspace(() => {
    const result = database.createJournalDocuments([
      { occurredAt: AT, memo: 'تلاش برای دورزدن کنترل', lines: twoLines(110_000) },
    ], { approvalState: 'approved' });
    const created = accounting.listJournal(database.db, { entryId: result.entryIds[0] }).items[0];
    assert.equal(created.approvalState, 'draft');
  });
});

test('the maker cannot approve the same document', () => {
  let target;
  inWorkspace(() => {
    target = database.createJournalDocuments([
      { occurredAt: AT, memo: 'کنترل دو نفره', lines: twoLines(115_000) },
    ]).entryIds[0];
    database.submitJournalApproval(target, 'submitted');
    assert.throws(
      () => database.submitJournalApproval(target, 'approved'),
      (error) => error.code === 'JOURNAL_SELF_APPROVAL',
    );
  });
  reviewInWorkspace(() => {
    assert.equal(database.submitJournalApproval(target, 'approved').to, 'approved');
  });
});

test('a draft moves through submission and control with a full trail', () => {
  const target = batchIds[0];
  inWorkspace(() => {
    assert.equal(database.submitJournalApproval(target, 'submitted').to, 'submitted');
    const submitted = accounting.listJournal(database.db, { entryId: target }).items[0];
    assert.equal(submitted.approvalState, 'submitted');
    assert.ok(submitted.submittedAt);
    assert.equal(submitted.submittedBy, owner.id);

  });
  reviewInWorkspace(() => {
    assert.equal(database.submitJournalApproval(target, 'approved').to, 'approved');
    const approved = accounting.listJournal(database.db, { entryId: target }).items[0];
    assert.equal(approved.approvalState, 'approved');
    assert.equal(approved.reviewedBy, reviewerId);
    assert.ok(approved.reviewedAt);
  });
});

test('a returned document carries its reason back to the maker', () => {
  const target = batchIds[1];
  inWorkspace(() => {
    database.submitJournalApproval(target, 'submitted');
  });
  reviewInWorkspace(() => {
    database.submitJournalApproval(target, 'returned', 'کد حساب درآمد اشتباه انتخاب شده است');
    const returned = accounting.listJournal(database.db, { entryId: target }).items[0];
    assert.equal(returned.approvalState, 'returned');
    assert.equal(returned.returnReason, 'کد حساب درآمد اشتباه انتخاب شده است');
  });
  inWorkspace(() => {
    // ثبت‌کننده دوباره می‌فرستد و دلیل برگشت پاک می‌شود.
    database.submitJournalApproval(target, 'submitted');
    assert.equal(accounting.listJournal(database.db, { entryId: target }).items[0].returnReason, '');
  });
});

test('an approved document cannot be walked backwards through the API path', () => {
  inWorkspace(() => {
    assert.throws(() => database.submitJournalApproval(batchIds[0], 'submitted'), (error) => error.code === 'JOURNAL_STATE_FORBIDDEN');
    assert.throws(() => database.submitJournalApproval('no-such-entry', 'submitted'), (error) => error.code === 'JOURNAL_ENTRY_NOT_FOUND');
  });
});

test('the worklist filter returns only the requested state', () => {
  inWorkspace(() => {
    const drafts = accounting.listJournal(database.db, { approvalState: 'draft', limit: 100 });
    assert.ok(drafts.items.every((item) => item.approvalState === 'draft'));
    assert.equal(drafts.total, drafts.items.length);
  });
});

test('an uncontrolled document blocks the accountant export', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    database.applyChartSuggestions();
    const overview = database.accountingTransferOverview('', 'generic-csv');
    const approvalCheck = overview.readiness.checks.find((item) => item.id === 'approval');
    assert.equal(approvalCheck.passed, false);
    assert.ok(approvalCheck.count > 0);
    assert.equal(overview.readiness.ready, false);
  });
});

test('once every document is controlled the export opens again', () => {
  inWorkspace(() => {
    for (const entry of accounting.listJournal(database.db, { limit: 200 }).items) {
      if (entry.approvalState === 'draft' || entry.approvalState === 'returned') database.submitJournalApproval(entry.id, 'submitted');
    }
  });
  reviewInWorkspace(() => {
    for (const entry of accounting.listJournal(database.db, { limit: 200 }).items) {
      if (entry.approvalState === 'submitted') database.submitJournalApproval(entry.id, 'approved');
    }
  });
  inWorkspace(() => {
    database.applyChartSuggestions();
    const overview = database.accountingTransferOverview('', 'generic-csv');
    assert.equal(overview.readiness.checks.find((item) => item.id === 'approval').passed, true);
    assert.equal(database.journalWorklistOverview().summary.clear, true);
  });
});

test('a saved template keeps its lines and refuses an unknown account', () => {
  inWorkspace(() => {
    const saved = database.saveJournalTemplate({
      name: 'فروش نقدی روزانه', memo: 'الگوی فروش',
      lines: [{ accountId: cash.id, description: 'دریافت' }, { accountId: income.id, description: 'فروش' }],
    });
    assert.equal(saved.name, 'فروش نقدی روزانه');
    assert.equal(saved.lines.length, 2);
    assert.equal(database.listJournalTemplates().length, 1);

    // ذخیره با همان نام، الگو را به‌روز می‌کند و کپی دوم نمی‌سازد.
    database.saveJournalTemplate({ name: 'فروش نقدی روزانه', lines: saved.lines, memo: 'به‌روزشده' });
    assert.equal(database.listJournalTemplates().length, 1);
    assert.equal(database.listJournalTemplates()[0].memo, 'به‌روزشده');

    assert.throws(() => database.saveJournalTemplate({ name: 'خراب', lines: [{ accountId: 'ghost' }, { accountId: income.id }] }), (error) => error.code === 'LEDGER_ACCOUNT_MISSING');
    assert.equal(database.deleteJournalTemplate(saved.id), true);
    assert.equal(database.deleteJournalTemplate(saved.id), false);
  });
});

test('the firm desk shows an uncontrolled document as a blocker', () => {
  inWorkspace(() => {
    database.createJournalDocuments([{ occurredAt: AT, memo: 'سند تازه', lines: twoLines(120_000) }]);
  });
  database.invalidateFirmCache(workspace.id);
  const client = database.firmPortfolio(owner.id, { refresh: true }).clients.find((item) => item.workspace.id === workspace.id);
  assert.equal(client.level, 'blocked');
  assert.ok(client.blockers.some((item) => item.id === 'pendingApproval'));
});

// دفتر یک‌نفره: تفکیک ثبت‌کننده از کنترل‌کننده وقتی کنترل‌کنندهٔ دومی وجود ندارد
// فقط سند را برای همیشه در «منتظر کنترل» حبس می‌کند و خروجی دفتر را می‌بندد.
test('a one-person office may control its own document, and the trail says so', () => {
  const soloWorkspace = database.createWorkspace(owner.id, { name: 'دفتر یک‌نفره', profileType: 'business' });
  const soloInWorkspace = (callback) => database.runInWorkspace(soloWorkspace.id, { role: 'owner', userId: owner.id }, callback);

  soloInWorkspace(() => {
    const availability = database.workspaceCheckerAvailability(soloWorkspace.id, owner.id);
    assert.equal(availability.otherCheckerCount, 0);
    assert.equal(availability.soloChecker, true);
    assert.equal(database.journalWorklistOverview().checkers.soloChecker, true);

    const accounts = database.listAccounts();
    const soloCash = accounts.find((item) => item.kind === 'cash') || accounts[0];
    database.insertTransactions({
      transcript: 'فروش دفتر یک‌نفره',
      transactions: [{ amount: 4_000_000, type: 'income', category: 'فروش', rawText: 'فروش دفتر یک‌نفره', occurredAt: AT, accountId: soloCash.id }],
    });
    const ledger = accounting.listLedgerAccounts(database.db);
    const soloIncome = ledger.find((item) => item.type === 'income');
    const soloAsset = ledger.find((item) => item.type === 'asset');

    const target = database.createJournalDocuments([{
      occurredAt: AT,
      memo: 'سند دفتر یک‌نفره',
      lines: [
        { accountId: soloAsset.id, debit: 250_000, description: 'دریافت' },
        { accountId: soloIncome.id, credit: 250_000, description: 'فروش' },
      ],
    }]).entryIds[0];

    assert.equal(database.submitJournalApproval(target, 'submitted').to, 'submitted');
    const approval = database.submitJournalApproval(target, 'approved');
    assert.equal(approval.to, 'approved');
    assert.equal(approval.selfApproved, true);

    // خودتأییدی باید در Audit Log با علتش دیده شود، نه اینکه بی‌صدا بگذرد.
    const trail = database.db.prepare(
      "SELECT payload FROM audit_log WHERE action='approval' AND entity_id=? ORDER BY rowid DESC LIMIT 1",
    ).get(target);
    const payload = JSON.parse(trail.payload);
    assert.equal(payload.selfApproved, true);
    assert.equal(payload.selfApprovalGround, 'دفتر کنترل‌کنندهٔ دیگری ندارد');

    // سند تأییدشده باید در تراز دیده شود؛ همین چیزی است که حبس در «منتظر کنترل» می‌گرفت.
    const balance = accounting.trialBalance(database.db);
    assert.ok(balance.totals.debit >= 250_000);
  });
});

// به محض اینکه کنترل‌کنندهٔ دوم اضافه شود، تفکیک دوباره اجباری می‌شود.
test('adding a second controller closes self-approval again', () => {
  const pairWorkspace = database.createWorkspace(owner.id, { name: 'دفتر دو‌نفره', profileType: 'business' });
  database.addWorkspaceMember(pairWorkspace.id, {
    username: 'pair-reviewer', displayName: 'کنترل‌کنندهٔ دوم', role: 'manager',
    temporaryPassword: 'Second-Control-Passphrase-9930',
  });
  const availability = database.workspaceCheckerAvailability(pairWorkspace.id, owner.id);
  assert.equal(availability.otherCheckerCount, 1);
  assert.equal(availability.soloChecker, false);

  database.runInWorkspace(pairWorkspace.id, { role: 'owner', userId: owner.id }, () => {
    // دفتر تازه تا اولین ثبت، حساب دفتر کل ندارد.
    database.insertTransactions({
      transcript: 'فروش دفتر دونفره',
      transactions: [{ amount: 3_000_000, type: 'income', category: 'فروش', rawText: 'فروش دفتر دونفره', occurredAt: AT }],
    });
    const ledger = accounting.listLedgerAccounts(database.db);
    const pairIncome = ledger.find((item) => item.type === 'income');
    const pairAsset = ledger.find((item) => item.type === 'asset');
    const target = database.createJournalDocuments([{
      occurredAt: AT,
      memo: 'سند دفتر دونفره',
      lines: [
        { accountId: pairAsset.id, debit: 90_000, description: 'دریافت' },
        { accountId: pairIncome.id, credit: 90_000, description: 'فروش' },
      ],
    }]).entryIds[0];
    database.submitJournalApproval(target, 'submitted');
    assert.throws(
      () => database.submitJournalApproval(target, 'approved'),
      (error) => error.code === 'JOURNAL_SELF_APPROVAL',
    );
  });
});

test.after(() => removeTempDatabase(databasePath));
