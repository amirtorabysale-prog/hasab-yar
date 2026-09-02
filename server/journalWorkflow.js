// فاز ۳ — شمارهٔ سند ترتیبی، گردش ثبت‌کننده/کنترل‌کننده و ثبت انبوه.
//
// دو نیاز واقعی دفتر حسابداری که تا امروز پاسخ نداشتند:
//
// ۱. دفتر قانونی شمارهٔ سند ترتیبی سالانه و بدون گپ می‌خواهد. شناسهٔ UUID برای
//    ارجاع داخلی خوب است، اما حسابدار با «سند ۱۴۲» کار می‌کند نه با یک UUID.
// ۲. کمک‌حسابدار ثبت می‌زند و حسابدار ارشد کنترل می‌کند. تا وقتی این دو نقش در
//    داده جدا نشوند، «کنترل شد» فقط یک ادعای شفاهی است.

function workflowError(message, code = 'JOURNAL_WORKFLOW_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// draft: ثبت‌کننده هنوز کار دارد | submitted: منتظر کنترل
// approved: کنترل شد و قفل است | returned: با دلیل برگشت خورده
export const APPROVAL_STATES = Object.freeze({
  draft: Object.freeze({ id: 'draft', label: 'پیش‌نویس', owner: 'maker', blocksExport: true }),
  submitted: Object.freeze({ id: 'submitted', label: 'در انتظار کنترل', owner: 'checker', blocksExport: true }),
  returned: Object.freeze({ id: 'returned', label: 'برگشتی', owner: 'maker', blocksExport: true }),
  approved: Object.freeze({ id: 'approved', label: 'کنترل‌شده', owner: null, blocksExport: false }),
});

const TRANSITIONS = Object.freeze({
  draft: Object.freeze(['submitted']),
  submitted: Object.freeze(['approved', 'returned']),
  returned: Object.freeze(['submitted']),
  // سند کنترل‌شده به عقب برنمی‌گردد؛ اصلاحش با سند معکوس انجام می‌شود.
  approved: Object.freeze([]),
});

export function normalizeApprovalState(value) {
  return Object.hasOwn(APPROVAL_STATES, value) ? value : 'approved';
}

export function approvalStateLabel(value) {
  return APPROVAL_STATES[normalizeApprovalState(value)].label;
}

/**
 * انتقال وضعیت را می‌سنجد و علت رد را دقیق می‌گوید.
 * منطق خالص است تا بتوان همهٔ مسیرها را بدون دیتابیس آزمود.
 */
export function assertApprovalTransition(from, to, { reason = '', sameUser = false, allowSelfApproval = false } = {}) {
  const current = normalizeApprovalState(from);
  const next = String(to || '');
  if (!Object.hasOwn(APPROVAL_STATES, next)) throw workflowError(`وضعیت «${next}» شناخته نشد.`, 'JOURNAL_STATE_UNKNOWN');
  if (current === next) throw workflowError(`سند از قبل در وضعیت «${APPROVAL_STATES[current].label}» است.`, 'JOURNAL_STATE_UNCHANGED');
  if (!TRANSITIONS[current].includes(next)) {
    throw workflowError(
      current === 'approved'
        ? 'سند کنترل‌شده به عقب برنمی‌گردد؛ برای اصلاح، سند معکوس بزن.'
        : `سند «${APPROVAL_STATES[current].label}» نمی‌تواند مستقیم «${APPROVAL_STATES[next].label}» شود.`,
      'JOURNAL_STATE_FORBIDDEN', 409,
    );
  }
  if (next === 'returned' && String(reason || '').trim().length < 10) {
    throw workflowError('برای برگرداندن سند، دلیل را با حداقل ۱۰ نویسه بنویس؛ ثبت‌کننده باید بداند چه چیزی را اصلاح کند.', 'JOURNAL_RETURN_REASON_REQUIRED');
  }
  if (next === 'approved' && sameUser && !allowSelfApproval) {
    throw workflowError('کنترل‌کننده نمی‌تواند همان ثبت‌کنندهٔ سند باشد.', 'JOURNAL_SELF_APPROVAL', 403);
  }
  return { from: current, to: next };
}

export function ensureJournalWorkflowSchema(database) {
  const addColumn = (table, definition) => {
    try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); }
    catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
  };
  addColumn('journal_entries', 'document_number INTEGER');
  addColumn('journal_entries', "fiscal_year TEXT NOT NULL DEFAULT ''");
  // اسناد موجود «کنترل‌شده» فرض می‌شوند؛ ورود این گردش نباید دفترهای فعلی را
  // یک‌شبه به حالت پیش‌نویس ببرد و خروجی‌شان را قفل کند.
  addColumn('journal_entries', "approval_state TEXT NOT NULL DEFAULT 'approved'");
  addColumn('journal_entries', 'submitted_by TEXT');
  addColumn('journal_entries', 'submitted_at TEXT');
  addColumn('journal_entries', 'reviewed_by TEXT');
  addColumn('journal_entries', 'reviewed_at TEXT');
  addColumn('journal_entries', "return_reason TEXT NOT NULL DEFAULT ''");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_document_number
      ON journal_entries(fiscal_year,document_number) WHERE document_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_journal_entries_approval ON journal_entries(approval_state,occurred_at);
    CREATE TABLE IF NOT EXISTS journal_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      memo TEXT NOT NULL DEFAULT '',
      lines TEXT NOT NULL DEFAULT '[]',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * شمارهٔ بعدی همان سال مالی. چون سند هرگز حذف نمی‌شود (اصلاح با سند معکوس
 * انجام می‌شود)، این دنباله گپ نمی‌گیرد.
 */
export function nextDocumentNumber(database, fiscalYear) {
  const row = database.prepare('SELECT COALESCE(MAX(document_number),0) AS last FROM journal_entries WHERE fiscal_year=?').get(String(fiscalYear));
  return Number(row?.last || 0) + 1;
}

/**
 * اسناد قدیمی را شماره‌گذاری می‌کند: به ترتیب تاریخ وقوع و سپس زمان ثبت، تا
 * شماره‌ها با ترتیب واقعی دفتر هم‌خوان باشند.
 */
export function backfillDocumentNumbers(database, fiscalYearOf) {
  const pending = database.prepare(`SELECT id,occurred_at AS occurredAt FROM journal_entries
    WHERE document_number IS NULL ORDER BY occurred_at,created_at,rowid`).all();
  if (!pending.length) return { numbered: 0 };
  const counters = new Map();
  const update = database.prepare('UPDATE journal_entries SET document_number=?,fiscal_year=? WHERE id=?');
  for (const entry of pending) {
    const year = fiscalYearOf(entry.occurredAt);
    if (!counters.has(year)) counters.set(year, nextDocumentNumber(database, year) - 1);
    const number = counters.get(year) + 1;
    counters.set(year, number);
    update.run(number, year, entry.id);
  }
  return { numbered: pending.length };
}

/**
 * خلاصهٔ کارتابل: چند سند در هر وضعیت و چند تا منتظر خود این کاربر است.
 * منطق خالص تا بتوان بدون دیتابیس آزمودش.
 */
export function worklistSummary(entries = [], { userId = '' } = {}) {
  const byState = { draft: 0, submitted: 0, returned: 0, approved: 0 };
  let mine = 0;
  for (const entry of entries) {
    const state = normalizeApprovalState(entry.approvalState);
    byState[state] += 1;
    if (state === 'submitted') mine += 1;
    else if (['draft', 'returned'].includes(state) && entry.createdBy && entry.createdBy === userId) mine += 1;
  }
  const pending = byState.draft + byState.submitted + byState.returned;
  return {
    ...byState,
    pending,
    waitingForMe: mine,
    // «همه کنترل شد» فقط وقتی درست است که واقعاً سندی در جریان نمانده باشد.
    clear: pending === 0,
  };
}

export function normalizeTemplateLines(lines = []) {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length < 2 || list.length > 100) throw workflowError('الگوی سند باید بین ۲ تا ۱۰۰ آرتیکل داشته باشد.');
  return list.map((line, index) => {
    const accountId = String(line?.accountId || '').trim();
    if (!accountId) throw workflowError(`آرتیکل ${index + 1} حساب ندارد.`);
    const debit = Math.max(0, Math.round(Number(line?.debit) || 0));
    const credit = Math.max(0, Math.round(Number(line?.credit) || 0));
    // الگو می‌تواند مبلغ نداشته باشد؛ فقط چیدمان حساب‌ها را نگه می‌دارد.
    if (debit && credit) throw workflowError(`آرتیکل ${index + 1} هم بدهکار دارد و هم بستانکار.`);
    return {
      accountId, debit, credit,
      description: String(line?.description || '').slice(0, 300),
      analyticId: line?.analyticId || null,
      costCenterId: line?.costCenterId || null,
    };
  });
}
