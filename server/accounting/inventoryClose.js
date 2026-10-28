// سند پایان دورهٔ انبار — پل میان موجودی ادواری پارسیان و دفتر کل.
//
// پارسیان در روش ادواری خرید را در حساب «خرید» (موقت) نگه می‌دارد و حساب موجودی تا پایان
// سال همان ماندهٔ اول دوره را دارد. تا سند پایان دوره زده نشود، سود سال کل خرید را هزینه
// گرفته و موجودی پایان دوره را ندیده است. حساب‌یار موجودی پایان دوره را از گردش فاکتورها
// (server/parsianStock.js، میانگین موزون) دارد؛ این ماژول از آن **پیشنهاد** سند می‌سازد:
//
//   موجودی اول دوره (حساب‌های موجودی)      بستانکار  → صفر
//   خرید کالا (حساب‌هایی که فاکتور خرید رویشان نشسته) بستانکار → صفر
//   برگشت از خرید                            بدهکار    → صفر
//   موجودی پایان دوره (یک حساب موجودی)       بدهکار
//   بهای تمام‌شدهٔ کالای فروش‌رفته           بدهکار    ← مابه‌التفاوت
//
// قاعده‌ها:
//   - سند «منتظر کنترل» ساخته می‌شود و تا حسابدار تأیید نکند در هیچ گزارشی نیست.
//   - حساب خرید از سند خود فاکتورهای خرید پیدا می‌شود، نه از نام (خرید لوازم مصرفی هم
//     زیر «خرید» است ولی کالای انبار نیست).
//   - اگر پارسیان خودش سند انبار یا بهای تمام‌شده زده، یا خرید را بسته، یا دفتر دائمی است،
//     پیشنهادی ساخته نمی‌شود؛ مانع صریح گفته می‌شود.
//   - دستمزد و سربار تولید جذب بهای تمام‌شده نمی‌شوند (هزینهٔ دوره می‌مانند) و فاصلهٔ
//     موجودی اول دوره در دفتر و در فاکتور اول دوره جدا گفته می‌شود.

import { randomUUID } from 'node:crypto';
import { accountingError, ensureAccountingSchema, fiscalStartMonth } from './ledgerAccounts.js';
import { insertJournal, nextRevision, validateLines } from './journalCore.js';
import { fiscalYearBounds } from './yearClose.js';
import { ensureInventorySchema } from '../inventory.js';
import { ensureParsianExtrasSchema } from '../parsianExtras.js';

const SOURCE_TYPE = 'inventory-close';
const MAX_LINES = 5000;

// نام‌ها در کدینگ پارسیان با «ي»، «ك»، کشیده و نیم‌فاصله می‌آیند.
const normalize = (text) => String(text || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[ـ‌]/g, '').replace(/\s+/g, ' ').trim();
const INVENTORY_NAME = /موجودی\s*(مواد|کالا)/;
const COGS_NAME = /(قیمت|بهای?)\s*تمام\s*شده\s*(کالای?|محصولات?)?\s*(فروش|فروخته)/;

export function ensureInventoryCloseSchema(database) {
  ensureAccountingSchema(database);
  database.exec(`CREATE TABLE IF NOT EXISTS inventory_close_entries (
    year TEXT PRIMARY KEY, entry_id TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '{}',
    created_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  return database;
}

function readYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1300 || year > 1500) throw accountingError('سال مالی باید یک سال شمسی چهاررقمی باشد.', 'FISCAL_YEAR_INVALID');
  return year;
}

/** حساب‌های دفتر کلِ زیر یک گره کدینگ (خودش و فرزندانش). */
function chartTree(database) {
  const nodes = database.prepare('SELECT id,parent_id AS parentId,code,name,type,role FROM chart_accounts').all()
    .map((row) => ({ ...row, clean: normalize(row.name) }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = (node) => {
    const chain = [];
    for (let current = node, seen = 0; current && seen < 10; current = byId.get(current.parentId), seen += 1) chain.push(current);
    return chain;
  };
  return { nodes, byId, ancestors };
}

/**
 * نقش حساب‌ها، با شاهد:
 *   موجودی     — معین با نقش «inventory» یا نامی که خودش یا کل بالایش «موجودی مواد/کالا» است؛
 *   خرید        — حساب هزینه‌ای که سند فاکتورهای خرید همین سال بدهکارش کرده؛
 *   برگشت خرید — حساب هزینه‌ای که سند فاکتورهای برگشت از خرید بستانکارش کرده؛
 *   بهای تمام‌شده — تنها حساب هزینه با نام «قیمت/بهای تمام‌شدهٔ کالای فروش‌رفته».
 */
function resolveRoles(database, bounds) {
  const tree = chartTree(database);
  const ledgers = database.prepare(`SELECT id,code,name,type,chart_account_id AS chartId FROM ledger_accounts WHERE active=1 OR active IS NULL`).all();
  const inventory = ledgers.filter((ledger) => {
    const node = tree.byId.get(ledger.chartId);
    if (!node || ledger.type !== 'asset') return false;
    return tree.ancestors(node).some((item) => item.role === 'inventory' || (INVENTORY_NAME.test(item.clean) && !/نقد/.test(item.clean)));
  });
  const cogs = ledgers.filter((ledger) => ledger.type === 'expense' && COGS_NAME.test(normalize(tree.byId.get(ledger.chartId)?.name || ledger.name)));

  ensureParsianExtrasSchema(database);
  const invoiceAccounts = (kind, side) => database.prepare(`SELECT DISTINCT jl.account_id AS id FROM parsian_invoice_archive a
      JOIN journal_lines jl ON jl.entry_id=a.entry_id JOIN ledger_accounts la ON la.id=jl.account_id
      WHERE a.kind=? AND a.occurred_at>=? AND a.occurred_at<? AND la.type='expense' AND jl.${side}>0`).all(kind, bounds.from, bounds.toExclusive).map((row) => row.id);
  const purchases = invoiceAccounts('purchase', 'debit');
  const returns = invoiceAccounts('purchase-return', 'credit').filter((id) => !purchases.includes(id));
  const byId = new Map(ledgers.map((ledger) => [ledger.id, ledger]));
  const describe = (ids) => ids.map((id) => byId.get(id)).filter(Boolean).map(({ id, code, name }) => ({ id, code, name }));
  return { inventory: describe(inventory.map((item) => item.id)), cogs: describe(cogs.map((item) => item.id)), purchases: describe(purchases), returns: describe(returns) };
}

/** خالص هر (حساب، تفصیلی، مرکز هزینه) در بازه، بی‌سندهای اختتامیه و افتتاحیهٔ سال و بی‌پیشنهاد خودمان. */
function balances(database, accountIds, { before, from = null, excludeEntryId = null }) {
  if (!accountIds.length) return [];
  return database.prepare(`SELECT jl.account_id AS accountId,jl.analytic_id AS analyticId,jl.cost_center_id AS costCenterId,
      SUM(jl.debit)-SUM(jl.credit) AS net
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    LEFT JOIN year_close_entries y ON y.entry_id=je.id
    WHERE jl.account_id IN (${accountIds.map(() => '?').join(',')}) AND je.occurred_at<? ${from ? 'AND je.occurred_at>=?' : ''}
      AND (y.role IS NULL OR y.role NOT IN ('closing','opening')) AND je.id IS NOT ?
    GROUP BY jl.account_id,jl.analytic_id,jl.cost_center_id HAVING net<>0`)
    .all(...accountIds, before, ...(from ? [from] : []), excludeEntryId).map((row) => ({ ...row, net: Number(row.net) }));
}

function planInventoryClose(database, yearValue, { timeZone = 'Asia/Tehran', targetLedgerAccountId = '' } = {}) {
  ensureInventoryCloseSchema(database);
  ensureInventorySchema(database);
  const year = readYear(yearValue);
  const bounds = fiscalYearBounds(year, timeZone, fiscalStartMonth(database));
  const blockers = [];
  const notes = [];
  const block = (code, message, extra = {}) => blockers.push({ code, message, ...extra });
  const existing = database.prepare(`SELECT i.entry_id AS entryId,je.approval_state AS state,je.document_number AS documentNumber
    FROM inventory_close_entries i JOIN journal_entries je ON je.id=i.entry_id WHERE i.year=?`).get(String(year)) || null;

  // ۱. گردش کالا: فقط از فاکتورهای پارسیان (ادواری). گردش دائمی حساب‌یار بهای تمام‌شده‌اش را خودش سند زده.
  const movements = database.prepare(`SELECT source_type AS sourceType,COUNT(*) AS count FROM stock_movements
    WHERE occurred_at>=? AND occurred_at<? GROUP BY source_type`).all(bounds.from, bounds.toExclusive);
  const periodic = movements.find((row) => row.sourceType === 'parsian_invoice')?.count || 0;
  const perpetual = movements.filter((row) => row.sourceType !== 'parsian_invoice').reduce((sum, row) => sum + row.count, 0);
  if (!periodic) block('INVENTORY_CLOSE_NOT_PERIODIC', `در سال ${bounds.label} گردش کالایی از فاکتورهای پارسیان نیست؛ سند پایان دورهٔ انبار فقط برای دفتر ادواریِ آمده از پارسیان است.`);
  if (perpetual) block('INVENTORY_CLOSE_MIXED', `${perpetual} گردش کالای حساب‌یار در همین سال هست که بهای تمام‌شده‌اش همان‌جا سند خورده؛ سند ادواری آن را دو بار می‌شمرد.`);

  // ۲. نقش حساب‌ها.
  const roles = resolveRoles(database, bounds);
  if (!roles.inventory.length) block('INVENTORY_ACCOUNT_MISSING', 'در کدینگ حسابی با نقش یا نام «موجودی مواد/کالا» پیدا نشد.');
  if (roles.cogs.length !== 1) {
    block('COGS_ACCOUNT_AMBIGUOUS', roles.cogs.length
      ? `${roles.cogs.length} حساب با نام «بهای تمام‌شدهٔ کالای فروش‌رفته» هست؛ کدام؟ (${roles.cogs.map((item) => item.code).join('، ')})`
      : 'حساب «قیمت/بهای تمام‌شدهٔ کالای فروش‌رفته» در کدینگ نیست؛ اول آن را در کدینگ بساز.');
  }
  if (!roles.purchases.length) block('PURCHASE_ACCOUNT_MISSING', `در سال ${bounds.label} هیچ فاکتور خریدی به سندی وصل نیست؛ حساب خرید کالا از روی شاهد معلوم نمی‌شود.`);
  const target = (targetLedgerAccountId && roles.inventory.find((item) => item.id === targetLedgerAccountId)) || null;
  if (targetLedgerAccountId && !target) block('INVENTORY_TARGET_INVALID', 'حساب انتخاب‌شده برای موجودی پایان دوره از حساب‌های موجودی نیست.');

  // ۳. کار پیش‌تر انجام شده؟ سند موجودی یا بهای تمام‌شده در سال (جز افتتاحیهٔ روز اول) یا خرید بسته‌شده.
  const inventoryIds = roles.inventory.map((item) => item.id);
  const cogsIds = roles.cogs.map((item) => item.id);
  const purchaseIds = roles.purchases.map((item) => item.id);
  const returnIds = roles.returns.map((item) => item.id);
  const touching = [...inventoryIds, ...cogsIds];
  if (touching.length) {
    const already = database.prepare(`SELECT DISTINCT je.document_number AS documentNumber FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      LEFT JOIN year_close_entries y ON y.entry_id=je.id
      WHERE jl.account_id IN (${touching.map(() => '?').join(',')}) AND je.occurred_at>=? AND je.occurred_at<? AND y.role IS NULL
        AND je.source_type<>? AND je.entry_kind<>'opening' AND je.occurred_at>=?`)
      .all(...touching, bounds.from, bounds.toExclusive, SOURCE_TYPE, new Date(Date.parse(bounds.from) + 86_400_000).toISOString());
    if (already.length) block('INVENTORY_ALREADY_CLOSED', `سند ${already.slice(0, 5).map((row) => row.documentNumber ?? '—').join('، ')} همین سال روی حساب موجودی یا بهای تمام‌شده نشسته است؛ پایان دورهٔ انبار پیش‌تر ثبت شده و سند دوم ساخته نمی‌شود.`);
  }
  const hasYearCloseLines = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='year_close_lines'").get();
  if (purchaseIds.length && hasYearCloseLines) {
    const closedPurchases = database.prepare(`SELECT COUNT(*) AS n FROM year_close_lines yl JOIN journal_lines jl ON jl.id=yl.line_id
      WHERE yl.year=? AND jl.account_id IN (${purchaseIds.map(() => '?').join(',')})`).get(String(year), ...purchaseIds).n;
    if (closedPurchases) block('PURCHASES_ALREADY_CLOSED', 'حساب خرید همین سال در سند بستن پارسیان بسته شده؛ سند انبار باید پیش از آن باشد و حدس زده نمی‌شود.');
  }
  if (database.prepare("SELECT 1 FROM fiscal_year_closings WHERE year=? AND status='closed'").get(String(year))) {
    block('FISCAL_YEAR_ALREADY_CLOSED', `سال ${bounds.label} بسته شده است؛ سند انبار باید پیش از بستن سال ثبت شود.`);
  }
  if (existing?.state === 'approved') block('INVENTORY_CLOSE_APPROVED', `سند پایان دورهٔ انبار این سال (سند ${existing.documentNumber}) کنترل شده است؛ برای اصلاح، سند معکوس بزن.`);

  // ۴. مبلغ‌ها.
  const exclude = existing?.entryId || null;
  const opening = balances(database, inventoryIds, { before: bounds.toExclusive, excludeEntryId: exclude });
  const purchaseLines = balances(database, purchaseIds, { before: bounds.toExclusive, from: bounds.from, excludeEntryId: exclude });
  const returnLines = balances(database, returnIds, { before: bounds.toExclusive, from: bounds.from, excludeEntryId: exclude });
  // کالا به کالا: کالایی که تا پایان سال به صفر رسیده ارزش صفر دارد، نه ته‌ماندهٔ گرد کردن گردش‌ها.
  // کالایی که بعد از پایان سال گردشی ندارد، همان ارزش ثبت‌شدهٔ خودش را می‌گیرد (دفترهایی که پیش از
  // گرد کردن تجمعی وارد شدند ته‌ماندهٔ گرد کردن در جمع گردش‌ها دارند).
  const ending = database.prepare(`SELECT SUM(m.quantity) AS quantity,SUM(m.value_delta) AS value,p.inventory_value AS current,
      (SELECT COUNT(*) FROM stock_movements later WHERE later.product_id=p.id AND later.occurred_at>=?) AS later
    FROM stock_movements m JOIN products p ON p.id=m.product_id
    WHERE p.track_inventory=1 AND m.occurred_at<? GROUP BY m.product_id`).all(bounds.toExclusive, bounds.toExclusive)
    .reduce((total, row) => total + (Math.abs(Number(row.quantity)) < 0.000001 ? 0 : Number(row.later ? row.value : row.current)), 0);
  const sum = (lines) => lines.reduce((total, line) => total + line.net, 0);
  const openingValue = sum(opening);
  const purchasesValue = sum(purchaseLines);
  const returnsValue = -sum(returnLines);
  const cogsValue = openingValue + purchasesValue - returnsValue - ending;
  if (ending < 0) block('INVENTORY_ENDING_NEGATIVE', 'ارزش موجودی پایان دوره منفی است؛ گردش کالا را پیش از سند انبار بررسی کن.');
  if (!blockers.length && cogsValue < 0) block('COGS_NEGATIVE', `بهای تمام‌شده منفی درمی‌آید (${cogsValue.toLocaleString('en-US')}): موجودی پایان دوره از اول دوره به‌علاوهٔ خرید بیشتر است. خرید یا موجودی اول دوره در دفتر کم است؛ حدس زده نمی‌شود.`);

  const defaultTarget = target || roles.inventory.find((item) => /پایان\s*دوره/.test(normalize(item.name)))
    || [...roles.inventory].sort((a, b) => Math.abs(sum(opening.filter((line) => line.accountId === b.id))) - Math.abs(sum(opening.filter((line) => line.accountId === a.id))))[0] || null;

  // ۵. یادداشت‌ها برای حسابدار.
  const invoiceOpening = Number(database.prepare(`SELECT COALESCE(SUM(m.value_delta),0) AS value FROM stock_movements m
    WHERE m.movement_type='opening' AND m.source_type='parsian_invoice' AND m.occurred_at>=? AND m.occurred_at<?`).get(bounds.from, bounds.toExclusive).value);
  if (invoiceOpening && invoiceOpening !== openingValue) notes.push(`موجودی اول دوره در دفتر ${openingValue.toLocaleString('en-US')} است و در فاکتور «موجودی اول دوره» ${invoiceOpening.toLocaleString('en-US')}؛ موجودی پایان دوره از فاکتور ساخته شده و این فاصله در بهای تمام‌شده می‌نشیند.`);
  const kinds = Object.fromEntries(database.prepare(`SELECT movement_type AS kind,COALESCE(SUM(value_delta),0) AS value FROM stock_movements
    WHERE source_type='parsian_invoice' AND occurred_at>=? AND occurred_at<? GROUP BY movement_type`).all(bounds.from, bounds.toExclusive).map((row) => [row.kind, Number(row.value)]));
  if (kinds.production && kinds.consumption && kinds.production + kinds.consumption) {
    notes.push(`ارزش تولید در فاکتورهای پارسیان ${kinds.production.toLocaleString('en-US')} و بهای مصرف به میانگین ${(-kinds.consumption).toLocaleString('en-US')} است؛ فاصله در موجودی پایان دوره و از آن‌جا در بهای تمام‌شده است.`);
  }
  if (kinds.sale) notes.push(`بهای فروش از گردش کالا (میانگین موزون) ${(-kinds.sale).toLocaleString('en-US')} است؛ بهای تمام‌شدهٔ این سند ${cogsValue.toLocaleString('en-US')}.`);
  notes.push('دستمزد و سربار تولید جذب بهای تمام‌شده نمی‌شوند و هزینهٔ دوره می‌مانند؛ اگر باید جذب شوند، سند جدا بزن.');
  const unapproved = database.prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE occurred_at>=? AND occurred_at<? AND approval_state<>'approved' AND source_type<>?`)
    .get(bounds.from, bounds.toExclusive, SOURCE_TYPE).n;
  if (unapproved) notes.push(`${unapproved} سند این سال هنوز کنترل نشده؛ مبلغ‌ها همهٔ سندها را می‌شمارند، ولی گزارش‌ها فقط سند کنترل‌شده را.`);

  const lines = [];
  const description = `پایان دورهٔ انبار ${bounds.label}`;
  for (const line of opening) lines.push({ accountId: line.accountId, analyticId: line.analyticId, costCenterId: line.costCenterId, debit: line.net < 0 ? -line.net : 0, credit: line.net > 0 ? line.net : 0, description: `بستن موجودی اول دوره — ${description}` });
  for (const line of purchaseLines) lines.push({ accountId: line.accountId, analyticId: line.analyticId, costCenterId: line.costCenterId, debit: line.net < 0 ? -line.net : 0, credit: line.net > 0 ? line.net : 0, description: `انتقال خرید به بهای تمام‌شده — ${description}` });
  for (const line of returnLines) lines.push({ accountId: line.accountId, analyticId: line.analyticId, costCenterId: line.costCenterId, debit: line.net < 0 ? -line.net : 0, credit: line.net > 0 ? line.net : 0, description: `انتقال برگشت از خرید — ${description}` });
  if (ending > 0 && defaultTarget) lines.push({ accountId: defaultTarget.id, debit: ending, credit: 0, description: `موجودی پایان دوره (میانگین موزون) — ${description}` });
  if (cogsValue && roles.cogs[0]) lines.push({ accountId: roles.cogs[0].id, debit: cogsValue > 0 ? cogsValue : 0, credit: cogsValue < 0 ? -cogsValue : 0, description: `بهای تمام‌شدهٔ کالای فروش‌رفته — ${description}` });
  if (lines.length > MAX_LINES) block('INVENTORY_CLOSE_TOO_LARGE', `سند ${lines.length} آرتیکل دارد که از سقف ${MAX_LINES} بیشتر است.`);

  return {
    bounds, lines, existing,
    summary: {
      year, label: bounds.label, ready: blockers.length === 0, blockers, notes,
      at: new Date(Date.parse(bounds.toExclusive) - 3000).toISOString(),
      accounts: { ...roles, target: defaultTarget },
      amounts: { opening: openingValue, purchases: purchasesValue, returns: returnsValue, ending, cogs: cogsValue },
      lines: lines.length,
      existing: existing ? { entryId: existing.entryId, documentNumber: existing.documentNumber, state: existing.state } : null,
    },
  };
}

/** پیش‌نمایش: مبلغ‌ها، حساب‌ها با شاهدشان، مانع‌ها و یادداشت‌ها. چیزی نمی‌نویسد. */
export function previewInventoryClose(database, year, options = {}) {
  return planInventoryClose(database, year, options).summary;
}

/**
 * ساخت یا بازسازی پیشنهاد سند. سند «منتظر کنترل» است؛ پیشنهاد کنترل‌نشده با همان شماره
 * بازسازی می‌شود (آرتیکل‌هایش عوض می‌شوند) تا شمارهٔ سند گپ نگیرد.
 */
export function proposeInventoryClose(database, year, { userId = null, timeZone = 'Asia/Tehran', targetLedgerAccountId = '' } = {}) {
  const plan = planInventoryClose(database, year, { timeZone, targetLedgerAccountId });
  if (!plan.summary.ready) {
    throw Object.assign(accountingError(plan.summary.blockers.map((item) => item.message).join(' '), plan.summary.blockers[0].code, 409), { details: { blockers: plan.summary.blockers } });
  }
  const memo = `سند پایان دورهٔ انبار ${plan.bounds.label} (روش ادواری): موجودی پایان دوره از گردش فاکتورها به میانگین موزون؛ پیشنهاد حساب‌یار، منتظر کنترل حسابدار`;
  database.exec('BEGIN IMMEDIATE');
  try {
    let entryId;
    if (plan.existing) {
      const validated = validateLines(database, plan.lines, { maxLines: MAX_LINES });
      entryId = plan.existing.entryId;
      database.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(entryId);
      const insert = database.prepare('INSERT INTO journal_lines (id,entry_id,account_id,debit,credit,description,analytic_id,cost_center_id) VALUES (?,?,?,?,?,?,?,?)');
      for (const line of validated.lines) insert.run(randomUUID(), entryId, line.accountId, line.debit, line.credit, line.description, line.analyticId || null, line.costCenterId || null);
      database.prepare("UPDATE journal_entries SET memo=?,approval_state='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP,return_reason='' WHERE id=?").run(memo.slice(0, 500), userId, entryId);
    } else {
      const sourceId = `inventory-close:${plan.summary.year}`;
      const entry = insertJournal(database, {
        sourceType: SOURCE_TYPE, sourceId, revision: nextRevision(database, SOURCE_TYPE, sourceId), occurredAt: plan.summary.at,
        memo, createdBy: userId, timeZone, approvalState: 'submitted', lines: plan.lines, maxLines: MAX_LINES,
      });
      entryId = entry.id;
    }
    database.prepare(`INSERT INTO inventory_close_entries (year,entry_id,summary,created_by) VALUES (?,?,?,?)
      ON CONFLICT(year) DO UPDATE SET entry_id=excluded.entry_id,summary=excluded.summary,created_by=excluded.created_by,updated_at=CURRENT_TIMESTAMP`)
      .run(String(plan.summary.year), entryId, JSON.stringify(plan.summary.amounts), userId);
    database.exec('COMMIT');
    const saved = database.prepare('SELECT document_number AS documentNumber,approval_state AS state FROM journal_entries WHERE id=?').get(entryId);
    return { ...plan.summary, entryId, documentNumber: saved.documentNumber, state: saved.state, rebuilt: Boolean(plan.existing) };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
