// فاز ب ورود پارسیان: ساخت حساب‌های عملیاتی و اشخاص از کدینگِ واردشده.
//
// ورود بکاپ (فاز الف) ستون فقرات حسابداری را می‌آورد: کدینگ، تفصیلی و اسناد.
// ولی بخش‌های روزمرهٔ حساب‌یار — «صندوق و بانک»، «تنخواه‌گردان» و «اشخاص» —
// جدول‌های خودشان را دارند و از کدینگ پر نمی‌شوند. این ماژول همان دادهٔ واردشده
// را به آن بخش‌ها وصل می‌کند، بی‌آنکه هیچ سند تازه‌ای بسازد یا مبلغی جابه‌جا کند:
//
//   - معین‌های زیر کل صندوق (۱۰) و بانک‌ها (۱۱) حساب عملیاتی می‌گیرند. حساب
//     دفتر کلِ همان معین — که اسناد پارسیان رویش نشسته — به حساب عملیاتی
//     «می‌چسبد» (source_kind='operational-account')، پس کارت بانک از همان لحظه
//     همهٔ گردش واردشده را با مانده نشان می‌دهد. نگاشت کدینگ دست‌نخورده می‌ماند
//     و فایل انتقال به پارسیان همان خروجی قبلی را می‌سازد.
//   - معین «تنخواه» (از نام یا نقش کدینگ) صندوق تنخواه می‌شود؛ بدون سقف حدسی —
//     سقف صفر یعنی «هنوز تعیین نشده» و بعداً از صفحهٔ تنخواه‌گردان گذاشته می‌شود.
//     پرداختِ اولیهٔ تنخواه ساخته نمی‌شود چون اسناد واقعی‌اش از قبل در دفتر است.
//   - تفصیلی‌های «طرف حساب» به شخص تبدیل می‌شوند و ردیف‌های سندشان از حساب
//     مشترک معین به حساب اختصاصی همان شخص می‌رود — همان حسابی که کارت طرف حساب
//     می‌خواند. حساب اختصاصی به همان معینِ پارسیان نگاشت می‌ماند و تفصیلی روی
//     ردیف‌ها سر جایش است، پس ستون‌های فایل انتقال (کل/معین/تفصیلی) عیناً
//     حفظ می‌شوند. کدام تفصیلی شخص است را کاربر در پیش‌نمایش تأیید می‌کند؛
//     پیش‌انتخاب، نام‌های حسابداری‌نما (مالیات، تهاتر، ارزش افزوده، …) را کنار
//     می‌گذارد.
//
// قاعدهٔ ثابت: هیچ سندی ثبت یا اصلاح نمی‌شود، هیچ مبلغی جابه‌جا نمی‌شود و هیچ
// حدسی زده نمی‌شود؛ اجرای دوباره چیزی را تکرار نمی‌سازد.

import { randomUUID } from 'node:crypto';
import { normalizedCounterpartyInput } from './counterparties.js';
import { normalizePersian } from '../shared/normalize.js';
import { audit } from './db/core.js';
import { nextLedgerCode } from './accounting.js';
import { acknowledgeImportedHistory } from './balanceGuard.js';
import { applyParsianCards } from './parsianExtras.js';

const KOL_CASH = '10';
const KOL_BANK = '11';
const KOL_RECEIVABLE = '12';
const KOL_PAYABLE = '23';

// نقش کدینگی که هر نوع حساب عملیاتی می‌گیرد؛ فقط وقتی پر می‌شود که خالی باشد.
const MOEEN_ROLE_BY_KIND = { cash: 'cash', bank: 'bank', petty: 'petty-cash' };
const KIND_LABELS = { cash: 'صندوق', bank: 'بانک', petty: 'تنخواه‌گردان' };

// نام‌هایی که حسابداری‌اند نه شخص: مالیات، تهاتر، ارزش افزوده، پرداختنی/دریافتنی،
// چک و مشتریان نامشخص (پوز). پیش‌انتخابِ پیش‌نمایش این‌ها را برمی‌دارد؛ تصمیم
// نهایی با کاربر است.
const NON_PERSON_PATTERN = /مالیات|تهاتر|ارزش افزوده|پرداختنی|پرداختی|دریافتنی|دریافتی|مشتریان پوز|چک|پوز/i;

function phaseBError(message, code = 'PARSIAN_PHASEB_INVALID', status = 400, details = undefined) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
}

/** آیا این دفتر ورود پارسیان دارد؟ گزارش ورود کامل یا کدینگِ با منشأ «import». */
function parsianImportPresent(database) {
  let logComplete = 0;
  try {
    logComplete = Number(database.prepare("SELECT COUNT(*) AS count FROM parsian_import_log WHERE status='complete'").get()?.count || 0);
  } catch { logComplete = 0; }
  let importChart = 0;
  try {
    importChart = Number(database.prepare("SELECT COUNT(*) AS count FROM chart_accounts WHERE source='import'").get()?.count || 0);
  } catch { importChart = 0; }
  const ok = logComplete > 0 || importChart > 0;
  return {
    ok, logComplete, importChart,
    message: ok ? '' : 'این دفتر ورود بکاپ پارسیان ندارد؛ اول بکاپ را از زبانهٔ «بکاپ پارسیان» وارد کن.',
  };
}

/** کل‌های صندوق و بانک — کد اصلی پارسیان در کد سطح یا خود کد می‌ماند. */
function moneyKol(database) {
  const rows = database.prepare(`SELECT id,code,name,level_code AS levelCode,type FROM chart_accounts
    WHERE level='general' AND active=1`).all();
  const find = (wanted) => rows.find((row) => row.levelCode === wanted || row.code === wanted) || null;
  return { cash: find(KOL_CASH), bank: find(KOL_BANK) };
}

/** نوع عملیاتی یک معین پولی: تنخواه از نام/نقش، بقیه از کل والد یا نقش. */
function moneyKind(moeen, kols) {
  const name = normalizePersian(moeen.name || '');
  if (moeen.role === 'petty-cash' || /تنخواه/.test(name)) return 'petty';
  if (moeen.role === 'bank' || moeen.parentCode === kols.bank?.code) return 'bank';
  if (moeen.role === 'cash' || moeen.parentCode === kols.cash?.code) return 'cash';
  return null;
}

/**
 * معین‌های پولی دفتر با وضعیت اتصالشان. منبع گردش و مانده، همان دفتر کل است
 * (همان چیزی که کارت حساب می‌خواند) — نه جمع‌زدن جدول‌های دیگر.
 */
function moneyMoeens(database) {
  const kols = moneyKol(database);
  if (!kols.cash && !kols.bank) return [];
  const parents = [kols.cash, kols.bank].filter(Boolean);
  return database.prepare(`SELECT chart_accounts.id,chart_accounts.code,chart_accounts.name,chart_accounts.role,
      chart_accounts.level_code AS levelCode,chart_accounts.parent_id AS parentId,parent.code AS parentCode,
      (SELECT COUNT(*) FROM ledger_accounts WHERE ledger_accounts.chart_account_id=chart_accounts.id
        AND ledger_accounts.source_kind='operational-account') AS boundCount,
      (SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) FROM journal_lines
        JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
        WHERE ledger_accounts.chart_account_id=chart_accounts.id) AS balance,
      (SELECT COUNT(*) FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
        WHERE ledger_accounts.chart_account_id=chart_accounts.id) AS lineCount
    FROM chart_accounts JOIN chart_accounts parent ON parent.id=chart_accounts.parent_id
    WHERE chart_accounts.level='subsidiary' AND chart_accounts.active=1
      AND chart_accounts.parent_id IN (${parents.map(() => '?').join(',')})
    ORDER BY chart_accounts.code`).all(...parents.map((kol) => kol.id))
    .map((row) => ({ ...row, kind: moneyKind(row, kols) }))
    .filter((row) => row.kind);
}

/**
 * تفصیلی‌های تبدیل‌شدنی به شخص: نوع «طرف حساب» که هنوز به شخصی وصل نشده‌اند.
 * گردش هر تفصیلی بر اساس معینِ خودِ ردیف‌ها گروه می‌شود تا سمت دریافتنی/پرداختنی
 * از کدینگ بیاید، نه از حدس.
 */
function contactCandidates(database) {
  const analytics = database.prepare(`SELECT id,code,name,external_code AS externalCode FROM analytic_accounts
    WHERE kind='contact' AND active=1 AND (source_kind IS NULL OR source_kind<>'contact')
    ORDER BY code`).all();
  const byChart = database.prepare(`SELECT chart_accounts.id AS chartId,chart_accounts.code AS chartCode,chart_accounts.name AS chartName,
      parent.code AS kolCode,parent.level_code AS kolLevelCode,
      COUNT(*) AS lineCount,COALESCE(SUM(journal_lines.debit),0) AS debit,COALESCE(SUM(journal_lines.credit),0) AS credit
    FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    JOIN chart_accounts parent ON parent.id=chart_accounts.parent_id
    WHERE journal_lines.analytic_id=? GROUP BY chart_accounts.id`);
  return analytics.map((analytic) => {
    const charts = byChart.all(analytic.id).map((row) => ({
      ...row,
      // سمت از کل پارسیان: ۱۲ دریافتنی، ۲۳ پرداختنی؛ بقیه به شخص تعلق نمی‌گیرند.
      side: row.kolLevelCode === KOL_RECEIVABLE || row.kolCode === KOL_RECEIVABLE ? 'receivable'
        : row.kolLevelCode === KOL_PAYABLE || row.kolCode === KOL_PAYABLE ? 'payable' : 'none',
    }));
    return {
      ...analytic,
      canonicalKey: normalizedCounterpartyInput(analytic.name).canonicalName,
      suggested: !NON_PERSON_PATTERN.test(normalizePersian(analytic.name || '')),
      charts,
    };
  });
}

/** صندوقِ عملیاتیِ موجود فقط وقتی بازاستفاده می‌شود که هنوز به معینی وصل نباشد. */
function reusableCashAccount(database) {
  const existing = database.prepare("SELECT id,name FROM accounts WHERE kind='cash' AND active=1 ORDER BY (id='cash') DESC,created_at").all();
  if (existing.length !== 1) return null;
  const bound = database.prepare("SELECT 1 FROM ledger_accounts WHERE source_kind='operational-account' AND source_key=?").get(existing[0].id);
  return bound ? null : existing[0];
}

/**
 * صندوق تنخواه فقط با ماندهٔ مثبتِ واقعی ساخته می‌شود: سقف = همان مانده، پس
 * «خرج‌شده» صفر است — درست همان چیزی که دفتر می‌گوید. ماندهٔ صفر یا منفی یعنی
 * گردش/شارژ تنخواه در این بکاپ نیست؛ ساختن صندوق با سقف حدسی جعل است، پس
 * ساخته نمی‌شود و پیامش گفته می‌شود.
 */
function pettyFundPossible(moeen) {
  return Number(moeen.balance || 0) > 0;
}

/** پیش‌نمایش فاز ب — هیچ چیزی نمی‌نویسد. */
export function previewParsianPhaseB(database) {
  const present = parsianImportPresent(database);
  const reusableCash = reusableCashAccount(database);
  const money = moneyMoeens(database).map((moeen) => ({
    id: moeen.id, code: moeen.code, name: moeen.name, levelCode: moeen.levelCode, kind: moeen.kind,
    kindLabel: KIND_LABELS[moeen.kind], balance: Number(moeen.balance || 0),
    lineCount: Number(moeen.lineCount || 0), bound: Number(moeen.boundCount || 0) > 0,
    // صندوق یکتای بازِ دفتر («cash» پیش‌فرض) بازاستفاده می‌شود؛ بانک و تنخواه تازه ساخته می‌شوند.
    reuseExistingCash: moeen.kind === 'cash' && Boolean(reusableCash),
    reuseExistingCashName: moeen.kind === 'cash' ? reusableCash?.name || '' : '',
    fundPossible: moeen.kind !== 'petty' || pettyFundPossible(moeen),
  }));
  const candidates = contactCandidates(database);
  const canonicalCounts = new Map();
  for (const candidate of candidates) canonicalCounts.set(candidate.canonicalKey, (canonicalCounts.get(candidate.canonicalKey) || 0) + 1);
  const contacts = candidates.map((candidate) => ({
    id: candidate.id, code: candidate.code, name: candidate.name,
    suggested: candidate.suggested,
    lineCount: candidate.charts.reduce((sum, chart) => sum + chart.lineCount, 0),
    debit: candidate.charts.reduce((sum, chart) => sum + chart.debit, 0),
    credit: candidate.charts.reduce((sum, chart) => sum + chart.credit, 0),
    sides: [...new Set(candidate.charts.filter((chart) => chart.side !== 'none').map((chart) => chart.side))],
    charts: candidate.charts.map((chart) => ({
      chartCode: chart.chartCode, chartName: chart.chartName, kolCode: chart.kolCode,
      side: chart.side, lineCount: chart.lineCount,
    })),
  }));
  return {
    eligible: present.ok, message: present.message,
    money, contacts,
    suggestedContactIds: contacts.filter((contact) => contact.suggested).map((contact) => contact.id),
    warnings: candidates
      .filter((candidate) => canonicalCounts.get(candidate.canonicalKey) > 1)
      .map((candidate) => `دو تفصیلی هم‌نام «${candidate.name}» هست؛ با هم به یک شخص وصل می‌شوند.`),
  };
}

/**
 * فاز ب بلافاصله پس از ورود اسناد، با پیش‌انتخابِ پیش‌نمایش: همهٔ حساب‌های پولی و
 * تفصیلی‌هایی که شخص‌اند (نام‌های حسابداری‌نما مثل مالیات و ارزش افزوده کنار
 * می‌مانند). تا پیش از این، فاز ب دکمهٔ جدایی پایین صفحه بود و بعد از ورود، بانک‌ها و
 * اشخاص خالی می‌ماندند. بقیهٔ تفصیلی‌ها هر وقت لازم شد از همان بخش «قدم بعد» شخص می‌شوند.
 */
export function completeParsianImport(database, { createdBy = null } = {}) {
  const preview = previewParsianPhaseB(database);
  if (!preview.eligible) return { skipped: preview.message };
  return commitParsianPhaseB(database, { contactIds: preview.suggestedContactIds, createdBy });
}

/** نام حساب یکتا؛ نام تکراری پسوند شماره می‌گیرد (همان قاعدهٔ تنخواه‌گردان). */
function uniqueAccountName(database, base) {
  if (!database.prepare('SELECT 1 FROM accounts WHERE name=?').get(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    if (!database.prepare('SELECT 1 FROM accounts WHERE name=?').get(`${base} (${index})`)) return `${base} (${index})`;
  }
  return `${base} ${randomUUID().slice(0, 6)}`;
}

/** حساب عملیاتی هر معین پولی: صندوقِ بازِ موجود بازاستفاده، بقیه تازه. */
function operationalAccountFor(database, moeen) {
  if (moeen.kind === 'cash') {
    const reusable = reusableCashAccount(database);
    if (reusable) return { id: reusable.id, name: reusable.name, created: false };
  }
  const id = moeen.kind === 'petty' ? `petty-${randomUUID()}` : randomUUID();
  const name = uniqueAccountName(database, moeen.name);
  database.prepare(`INSERT INTO accounts (id,name,kind,opening_balance,active,bank_id,allow_negative)
    VALUES (?,?,?,?,1,NULL,0)`).run(id, name, moeen.kind === 'petty' ? 'other' : moeen.kind, 0);
  return { id, name, created: true };
}

/** حساب دفتر کلِ معین را به حساب عملیاتی می‌چسبد؛ نگاشت کدینگ سر جایش می‌ماند. */
function bindMoeenLedger(database, moeen, accountId) {
  const ledger = database.prepare(`SELECT id,source_kind AS sourceKind FROM ledger_accounts
    WHERE chart_account_id=? ORDER BY CASE WHEN source_kind='chart-account' THEN 0 ELSE 1 END,rowid LIMIT 1`).get(moeen.id);
  if (!ledger) {
    const id = randomUUID();
    database.prepare(`INSERT INTO ledger_accounts (id,code,name,type,normal_side,source_kind,source_key,chart_account_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, nextLedgerCode(database, 'asset'), moeen.name, 'asset', 'debit', 'operational-account', accountId, moeen.id);
    return 'created';
  }
  if (ledger.sourceKind === 'operational-account') return 'already';
  database.prepare('UPDATE ledger_accounts SET source_kind=?,source_key=? WHERE id=?').run('operational-account', accountId, ledger.id);
  return 'bound';
}

/**
 * ثبت فاز ب. همهٔ معین‌های پولیِ هنوز وصل‌نشده و تفصیلی‌های انتخاب‌شده کاربر
 * پردازش می‌شوند؛ همه در یک تراکنش — یا همه یا هیچ.
 */
export function commitParsianPhaseB(database, { contactIds = [], createdBy = null } = {}) {
  const present = parsianImportPresent(database);
  if (!present.ok) throw phaseBError(present.message, 'PARSIAN_PHASEB_NO_IMPORT', 409);

  const result = {
    accounts: { created: 0, bound: 0, existing: 0, ledgerCreated: 0 },
    petty: 0,
    contacts: { created: 0, reused: 0, enriched: 0 },
    analyticsLinked: 0,
    linesRepointed: 0,
    chartRolesSet: 0,
    skipped: [],
    warnings: [],
  };

  database.exec('BEGIN IMMEDIATE');
  try {
    // --- ۱) حساب‌های پولی: صندوق، بانک، تنخواه ---
    for (const moeen of moneyMoeens(database)) {
      if (Number(moeen.boundCount || 0) > 0) { result.accounts.existing += 1; continue; }
      if (moeen.kind === 'petty' && !pettyFundPossible(moeen)) {
        result.skipped.push(`معین «${moeen.name}» (${moeen.code}) گردش یا ماندهٔ مثبت در این بکاپ ندارد؛ صندوق تنخواه ساخته نشد — با اولین پرداخت واقعی، از صفحهٔ تنخواه‌گردان بازش کن.`);
        continue;
      }
      const account = operationalAccountFor(database, moeen);
      if (account.created) result.accounts.created += 1;
      if (moeen.kind === 'petty') {
        database.prepare('INSERT INTO petty_cash_funds (account_id,holder_name,ceiling,note) VALUES (?,?,?,?)')
          .run(account.id, moeen.name.slice(0, 60), Math.round(Number(moeen.balance || 0)),
            'ساخته‌شده از کدینگ پارسیان؛ سقف = ماندهٔ ورودی. سقف تازه را از صفحهٔ تنخواه‌گردان بگذار.');
        result.petty += 1;
      }
      const state = bindMoeenLedger(database, moeen, account.id);
      if (state === 'bound') result.accounts.bound += 1;
      if (state === 'created') result.accounts.ledgerCreated += 1;
      if (state === 'already') result.accounts.existing += 1;
      if (moeen.role === '' && MOEEN_ROLE_BY_KIND[moeen.kind]) {
        database.prepare('UPDATE chart_accounts SET role=? WHERE id=? AND role=?').run(MOEEN_ROLE_BY_KIND[moeen.kind], moeen.id, '');
        result.chartRolesSet += 1;
      }
      audit(account.created ? 'create' : 'update', 'account', account.id, {
        source: 'parsian-phase-b', kind: moeen.kind, moeenCode: moeen.code, moeenName: moeen.name, createdBy,
      });
    }

    // --- ۲) اشخاص از تفصیلی‌های انتخاب‌شده ---
    const wanted = new Set((Array.isArray(contactIds) ? contactIds : []).map(String));
    const candidates = new Map(contactCandidates(database).map((candidate) => [String(candidate.id), candidate]));
    const groups = new Map();
    for (const id of wanted) {
      const candidate = candidates.get(id);
      if (!candidate) { result.skipped.push(`تفصیلی انتخاب‌شده (${id.slice(0, 12)}) پیدا یا قابل تبدیل نبود؛ کنار گذاشته شد.`); continue; }
      const groupKey = candidate.canonicalKey || candidate.name;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(candidate);
    }
    for (const [groupKey, group] of groups) {
      const sides = new Set(group.flatMap((candidate) => candidate.charts.filter((chart) => chart.side !== 'none').map((chart) => chart.side)));
      const kind = sides.size === 1 ? (sides.has('receivable') ? 'customer' : 'vendor') : 'person';
      const existing = database.prepare('SELECT id,name FROM contacts WHERE canonical_name=? ORDER BY created_at LIMIT 1').get(groupKey);
      let contact;
      if (existing) {
        contact = { id: existing.id, name: existing.name, reused: true };
        result.contacts.reused += 1;
      } else {
        // همان قاعدهٔ ذخیرهٔ شخص (نام یکسان‌شده و کلید مقایسه) ولی مستقیم روی
        // همین دیتابیس و داخل همین تراکنش؛ نام کوتاه/خالی ساکت رد نمی‌شود.
        const { displayName, canonicalName } = normalizedCounterpartyInput(group[0].name);
        if (!displayName || displayName.length < 2 || canonicalName !== groupKey) {
          result.skipped.push(`تفصیلی «${group[0].name}» نام معتبری برای شخص ندارد؛ کنار گذاشته شد.`);
          continue;
        }
        const contactId = randomUUID();
        database.prepare('INSERT INTO contacts (id,name,canonical_name,kind,phone,note) VALUES (?,?,?,?,?,?)')
          .run(contactId, displayName, canonicalName, kind, '', 'ساخته‌شده از تفصیلی‌های بکاپ پارسیان');
        contact = { id: contactId, name: displayName, reused: false };
        result.contacts.created += 1;
      }
      const contactAnalyticTaken = database.prepare('SELECT 1 FROM analytic_accounts WHERE source_kind=? AND source_key=?').get('contact', contact.id);
      // شخصِ موجود ممکن است از قبل تفصیلی خودش را داشته باشد؛ کلید یکتاست و
      // تفصیلی پارسیان فقط وقتی وصل می‌شود که جای او خالی باشد. از تفصیلی‌های
      // هم‌نامِ بعدی هم فقط یکی به شخص کلید می‌خورد — ردیف‌های همه‌شان به حساب
      // همان شخص می‌رود و تفصیلی‌شان برای پارسیان جدا می‌ماند.
      let contactAnalyticLinked = Boolean(contactAnalyticTaken);
      for (const candidate of group) {
        if (!contactAnalyticLinked) {
          database.prepare('UPDATE analytic_accounts SET source_kind=?,source_key=? WHERE id=? AND kind=?')
            .run('contact', contact.id, candidate.id, 'contact');
          contactAnalyticLinked = true;
          result.analyticsLinked += 1;
        } else if (!contactAnalyticTaken) {
          result.warnings.push(`تفصیلی هم‌نام «${candidate.name}» جدا ماند؛ ردیف‌هایش به حساب شخص «${contact.name}» می‌رود و ثبت تازه با تفصیلی اصلی او می‌نشیند.`);
        } else {
          result.warnings.push(`تفصیلی «${candidate.name}» به شخص «${contact.name}» وصل نشد؛ این شخص از قبل تفصیلی دارد. ردیف‌هایش به حساب او می‌رود ولی ثبت تازه با تفصیلی قبلی او می‌نشیند.`);
        }
        for (const chart of candidate.charts) {
          if (chart.side === 'none') {
            result.warnings.push(`ردیف‌های «${candidate.name}» روی معین ${chart.chartCode} («${chart.chartName}») زیر کل ${chart.kolCode} است؛ این کل دریافتنی/پرداختنی نیست و ردیف‌ها همان‌جا ماندند.`);
            continue;
          }
          const sourceKind = chart.side === 'receivable' ? 'customer-receivable' : 'vendor-payable';
          const type = chart.side === 'receivable' ? 'asset' : 'liability';
          const accountName = `${chart.side === 'receivable' ? 'حساب دریافتنی' : 'حساب پرداختنی'} — ${contact.name}`.slice(0, 120);
          let account = database.prepare('SELECT id FROM ledger_accounts WHERE source_kind=? AND source_key=? AND chart_account_id=?')
            .get(sourceKind, contact.id, chart.chartId);
          if (!account) {
            const id = randomUUID();
            database.prepare(`INSERT INTO ledger_accounts (id,code,name,type,normal_side,source_kind,source_key,chart_account_id)
              VALUES (?,?,?,?,?,?,?,?)`).run(id, nextLedgerCode(database, type), accountName, type,
              type === 'asset' ? 'debit' : 'credit', sourceKind, contact.id, chart.chartId);
            account = { id };
          }
          // فقط ردیف‌های همین تفصیلی که روی همین معین نشسته‌اند — حساب اختصاصیِ
          // همان معین. کدینگ ردیف عیناً حفظ می‌شود، پس فایل انتقال به پارسیان
          // تغییر نمی‌کند.
          const repointed = database.prepare(`UPDATE journal_lines SET account_id=?
            WHERE analytic_id=? AND account_id IN (SELECT id FROM ledger_accounts WHERE chart_account_id=?)`)
            .run(account.id, candidate.id, chart.chartId);
          result.linesRepointed += Number(repointed.changes || 0);
        }
      }
      // تلفن، نشانی و کدهای کارت پارسیانِ همین تفصیلی‌ها روی کارت شخص.
      if (applyParsianCards(database, contact.id, group.map((candidate) => candidate.id))) result.contacts.enriched += 1;
      audit(existing ? 'update' : 'create', 'contact', contact.id, {
        source: 'parsian-phase-b', reused: Boolean(existing), tafsili: group.map((candidate) => candidate.code), createdBy,
      });
    }
    // وصل‌کردن سابقه پولی جابه‌جا نمی‌کند؛ اگر ماندهٔ واقعیِ بانکی در بکاپ منفی است،
    // نگهبان موجودی آن را با همین دلیل ثبت می‌کند، نه اینکه کل اتصال را برگرداند.
    acknowledgeImportedHistory(database, { reason: 'ماندهٔ منفی از اسناد واردشدهٔ بکاپ پارسیان؛ اتصال حساب به سابقه، پولی جابه‌جا نکرد.', userId: createdBy, role: 'import' });
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return result;
}
