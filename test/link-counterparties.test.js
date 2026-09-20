import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { removeTempDatabase, tempDatabase } from './helpers/tempPath.js';

/**
 * اجرای اصلاحیِ وصل‌کردن ثبت‌های قدیمی به طرف حساب.
 *
 * این روی دفتر واقعی می‌نویسد، پس قیدهایش مهم‌تر از خود کارش‌اند و هر کدام
 * اینجا آزمون دارند: بدون `--apply` هیچ‌چیز نوشته نمی‌شود، ثبتی که از قبل
 * طرف حساب دارد دست نمی‌خورد، و جمله‌ای بدون عنوان صریح طرف حساب نمی‌سازد.
 */

const run = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');
const script = resolve(projectRoot, 'scripts', 'link-counterparties.mjs');
const databasePath = tempDatabase('link-counterparties');

process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'daftar';
process.env.ADMIN_PASSWORD = 'Rooz-Nameh-Kamel-8821';

const db = await import(`../server/db.js?link-backfill=${process.pid}`);
db.ensureAdmin();
const user = db.authenticateUser('daftar', 'Rooz-Nameh-Kamel-8821');
const workspace = db.workspaceForUser(user.id);

let knownId = '';
let taggedId = '';
db.runInWorkspace(workspace.id, { userId: user.id, role: 'owner' }, () => {
  knownId = db.saveContact({ name: 'شرکت آراد گستر آسیا', kind: 'vendor' }).id;
  const other = db.saveContact({ name: 'شرکت دیگر', kind: 'vendor' });
  for (const [rawText, amount, type] of [
    ['۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد', 93_000_000, 'expense'],
    ['پانصد هزار تومان به پیک دادم', 500_000, 'expense'],
  ]) {
    db.insertTransactions({ transcript: 'قدیمی', transactions: [{ amount, type, category: 'سایر', rawText }] });
  }
  // ثبتی که کاربر خودش به طرف حساب دیگری وصل کرده، با اینکه متنش نام دیگری دارد.
  [taggedId] = db.insertTransactions({
    transcript: 'دستی',
    transactions: [{ amount: 1_000_000, type: 'expense', category: 'سایر', contactId: other.id,
      rawText: 'یک میلیون به شرکت آراد گستر آسیا دادم' }],
  });
  db.db.prepare("UPDATE transactions SET contact_id=NULL WHERE id!=?").run(taggedId);
});

const linkedContactOf = (id) => {
  let value = null;
  db.runInWorkspace(workspace.id, { userId: user.id, role: 'owner' }, () => {
    value = db.db.prepare('SELECT contact_id AS contactId FROM transactions WHERE id=?').get(id)?.contactId || null;
  });
  return value;
};
const unlinkedCount = () => {
  let value = 0;
  db.runInWorkspace(workspace.id, { userId: user.id, role: 'owner' }, () => {
    value = db.db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE contact_id IS NULL").get().count;
  });
  return value;
};

test.after(() => removeTempDatabase(databasePath));

test('بدون --apply هیچ‌چیز نوشته نمی‌شود', async () => {
  // مهم‌ترین قید. دیدنِ نتیجه پیش از اعمالش روی دادهٔ مالی شرط است نه تجمل.
  const before = unlinkedCount();
  const { stdout } = await run('node', [script], { cwd: projectRoot, env: process.env });
  assert.match(stdout, /شرکت آراد گستر آسیا/, 'باید بگوید چه کار می‌کند');
  assert.match(stdout, /چیزی نوشته نشد/);
  assert.equal(unlinkedCount(), before, 'تعداد ثبت‌های وصل‌نشده نباید عوض شود');
});

test('با --apply ثبتِ نام‌دار به طرف حساب موجود وصل می‌شود', async () => {
  await run('node', [script, '--apply'], { cwd: projectRoot, env: process.env });
  let linked = null;
  db.runInWorkspace(workspace.id, { userId: user.id, role: 'owner' }, () => {
    linked = db.db.prepare("SELECT contact_id AS contactId FROM transactions WHERE raw_text LIKE '%پرداخت شد%'").get();
  });
  assert.equal(linked.contactId, knownId);
});

test('ثبتی که کاربر خودش وصل کرده دست نمی‌خورد', () => {
  // انتخاب کاربر از حدسِ متن مهم‌تر است، حتی وقتی متن نام دیگری دارد.
  assert.ok(linkedContactOf(taggedId));
  assert.notEqual(linkedContactOf(taggedId), knownId, 'نباید روی انتخاب کاربر بنویسد');
});

test('جملهٔ بدون عنوان صریح وصل نمی‌شود', () => {
  let pik = null;
  db.runInWorkspace(workspace.id, { userId: user.id, role: 'owner' }, () => {
    pik = db.db.prepare("SELECT contact_id AS contactId FROM transactions WHERE raw_text LIKE '%پیک%'").get();
  });
  assert.equal(pik.contactId, null, '«به پیک دادم» نباید طرف حساب بگیرد');
});

test('اجرای دوباره کاری نمی‌کند', async () => {
  const { stdout } = await run('node', [script, '--apply'], { cwd: projectRoot, env: process.env });
  assert.match(stdout, /۰ ثبت وصل شد/, 'اصلاحیه باید تکرارپذیر باشد');
});
