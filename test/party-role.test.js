// پرسنل و شریک در ورود بکاپ پارسیان «تأمین‌کننده» یا «مشتری» نمی‌شوند.
//
// گزارش کاربر (۸ آبان ۱۴۰۵): «پرسنل رفتن توی طرف حساب‌ها تازه به عنوان تأمین‌کننده …
// قشنگ اعلام شده پرسنله». تفصیلی زیر معین «حقوق پرداختي» بود و نامش «… پرسنل»؛ فاز ب
// نوع را فقط از سمت پرداختنی گرفته بود.
//
// خانواده:
//  - پرسنل از معین (حقوق پرداختنی، حقوق و دستمزد، مساعده، کارکنان) یا از نام («… پرسنل»).
//  - شریک از معین (جاری شرکا، سهامداران، مدیرعامل) یا از نام.
//  - منفی‌ها: بیمه و مالیاتِ حقوق، «حقوق صاحبان سهام» به‌عنوان پرسنل، «خدمات پرسنلی»،
//    تأمین‌کنندهٔ تجاری، مشتری، شخصی با هر دو نشانه.
//  - مسیرها: ورود تازه، دفترِ واردشده پیش از اصلاح (ترمیم)، تعریف دستی شخص.
// نام‌ها ساختگی‌اند (مخزن عمومی است).

import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPartyRole, partyRoleOf } from '../shared/partyRole.js';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';

test('نقش از نام حساب: معین حقوق پرسنل است، بیمه و مالیاتش نه', () => {
  const cases = [
    ['حقوق پرداختي', 'employee'], ['حقوق و دستمزد کارخانه', 'employee'], ['هزينه حقوق و دستمزد دفتر', 'employee'],
    ['مساعده کارکنان', 'employee'], ['بستانکاران پرسنل', 'employee'], ['عیدی و پاداش پرداختنی', 'employee'],
    ['جاری شرکا', 'partner'], ['حساب جاری مدیرعامل', 'partner'], ['سهامداران', 'partner'], ['حقوق صاحبان سهام', 'partner'],
    ['بیمه حقوق پرداختنی', ''], ['مالیات حقوق پرداختنی', ''], ['سازمان تامین اجتماعی', ''],
    ['حساب هاي پرداختني تجاري', ''], ['مشتریان', ''], ['ساير حساب هاي پرداختني', ''], ['', ''],
  ];
  for (const [name, role] of cases) assert.equal(accountPartyRole(name), role, name);
});

test('نقش از نام تفصیلی و از همهٔ تفصیلی‌های یک شخص', () => {
  // شکل گزارش کاربر، با نام ساختگی.
  assert.equal(partyRoleOf({ names: ['کارمند نمونه پرسنل'], charts: [{ chartName: 'ساير حساب هاي پرداختني', kolName: 'حسابهاي پرداختي' }] }), 'employee');
  assert.equal(partyRoleOf({ names: ['شریک نمونه'], charts: [] }), 'partner');
  // «پرسنلی» صفت شرکت است، نه کارمند.
  assert.equal(partyRoleOf({ names: ['شرکت خدمات پرسنلی نمونه'], charts: [{ chartName: 'حساب هاي پرداختني تجاري', kolName: 'حسابهاي پرداختي' }] }), '');
  // کل «حسابهای پرداختی» به‌تنهایی پرسنل نمی‌گوید.
  assert.equal(partyRoleOf({ names: ['شرکت نمونه آلفا'], charts: [{ chartName: 'حساب هاي پرداختني تجاري', kolName: 'حسابهاي پرداختي' }] }), '');
  // هم حقوق می‌گیرد هم جاری شرکا دارد: حدس زده نمی‌شود.
  assert.equal(partyRoleOf({ names: ['نمونه'], charts: [{ chartName: 'حقوق پرداختي' }, { chartName: 'جاری شرکا' }] }), '');
  // معین مالیات حقوق زیر کل «پرسنل»: باز هم پرسنل نیست.
  assert.equal(partyRoleOf({ names: ['اداره امور مالیاتی'], charts: [{ chartName: 'مالیات حقوق', kolName: 'بدهی به پرسنل' }] }), '');
});

const GROUPS = [{ Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' }, { Code: 61, CName: 'هزينه ها' }];
function tables() {
  // شکل بکاپ واقعی: کل ۲۲ «حسابهاي پرداختي» با معین‌های حقوق، تجاری و سایر.
  const kol = [
    { Code: 10, CName: 'موجودي نقد و بانک', GroupCode: 11, iType: 0 },
    { Code: 12, CName: 'حسابهاي دريافتني', GroupCode: 11, iType: 0 },
    { Code: 22, CName: 'حسابهاي پرداختي', GroupCode: 21, iType: 0 },
    { Code: 51, CName: 'هزينه حقوق و دستمزد', GroupCode: 61, iType: 1 },
  ];
  const moeen = [
    { KolCode: 10, Code: 3, CName: 'بانک ها' },
    { KolCode: 12, Code: 2, CName: 'مشتریان' },
    { KolCode: 22, Code: 2, CName: 'حقوق پرداختي' },
    { KolCode: 22, Code: 15, CName: 'حساب هاي پرداختني تجاري' },
    { KolCode: 22, Code: 17, CName: 'ساير حساب هاي پرداختني' },
    { KolCode: 22, Code: 18, CName: 'جاري شرکا' },
    { KolCode: 51, Code: 2, CName: 'حقوق و دستمزد کارخانه' },
  ];
  const tafsili = [
    { KolCode: 12, MoeenCode: 2, Code: 1, CName: 'مشتری نمونه' },
    { KolCode: 22, MoeenCode: 2, Code: 24, CName: 'کارمند نمونه پرسنل' },
    { KolCode: 22, MoeenCode: 2, Code: 25, CName: 'کارگر نمونه دوم' },
    { KolCode: 22, MoeenCode: 15, Code: 1, CName: 'شرکت نمونه آلفا' },
    { KolCode: 22, MoeenCode: 17, Code: 3, CName: 'راننده نمونه پرسنل' },
    { KolCode: 22, MoeenCode: 18, Code: 1, CName: 'شریک نمونه' },
  ];
  let id = 1;
  const row = (sanad, kolCode, moeenCode, taf, bed, bes, comment) => ({
    ID: id++, Sanad_Num: sanad, SanadDate: '1403/05/01', KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: taf, Comment: comment, Bed: bed, Bes: bes, SanadComment: null,
  });
  const document = [
    row(100, 12, 2, 1, 900000, 0, 'فروش'), row(100, 10, 3, 0, 0, 900000, 'فروش'),
    row(101, 51, 2, 0, 500000, 0, 'حقوق مرداد'), row(101, 22, 2, 24, 0, 300000, 'حقوق'), row(101, 22, 2, 25, 0, 200000, 'حقوق'),
    row(102, 10, 3, 0, 400000, 0, 'خرید'), row(102, 22, 15, 1, 0, 400000, 'خرید نسیه'),
    row(103, 10, 3, 0, 100000, 0, 'علی‌الحساب'), row(103, 22, 17, 3, 0, 100000, 'علی‌الحساب'),
    row(104, 10, 3, 0, 700000, 0, 'آورده'), row(104, 22, 18, 1, 0, 700000, 'آورده شریک'),
  ];
  return {
    tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document,
    tbl_AccSetting: [{ ID: 2, Cash_K: 0, Cash_M: 0, Cash_T: 0, Sell_K: 0, Sell_M: 0, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 }],
    tbl_VATSetting: [{ ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 }],
  };
}

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('party-role');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'role-owner';
process.env.ADMIN_PASSWORD = 'x-strong-password-1234';
const database = await import(`../server/db.js?party-role=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('role-owner', 'x-strong-password-1234');
const inWorkspace = (name, callback) => database.runInWorkspace(database.createWorkspace(owner.id, { name, profileType: 'business' }).id, { role: 'owner', userId: owner.id }, callback);
test.after(() => tempPathModule.removeTempDatabase(databasePath));
const { commitParsianBackup } = await import(`../server/parsianImport.js?party-role=${process.pid}`);
const { completeParsianImport, previewParsianPhaseB } = await import(`../server/parsianPhaseB.js?party-role=${process.pid}`);
const { repairParsianContactRoles } = await import(`../server/counterparties.js?party-role=${process.pid}`);

function importBackup(active) {
  commitParsianBackup(active, buildParsianBackup(tables()), 'roles.bak', { createdBy: owner.id, amountUnit: 'toman', kolTypes: { 51: 'expense' } });
}
const byName = () => Object.fromEntries(database.listContacts().map((contact) => [contact.name, contact]));

test('ورود بکاپ: پرسنل و شریک «شخص» با نقش‌اند؛ تأمین‌کننده و مشتری سر جایشان', () => {
  inWorkspace('نقش اشخاص', () => {
    const active = database.activeWorkspaceDatabase();
    importBackup(active);
    const preview = previewParsianPhaseB(active);
    assert.equal(preview.contacts.find((contact) => contact.name === 'کارمند نمونه پرسنل').role, 'employee');
    completeParsianImport(active, { createdBy: owner.id });
    const contacts = byName();
    const expect = {
      'کارمند نمونه پرسنل': ['person', 'employee'],
      'کارگر نمونه دوم': ['person', 'employee'],
      'راننده نمونه پرسنل': ['person', 'employee'],
      'شریک نمونه': ['person', 'partner'],
      'شرکت نمونه آلفا': ['vendor', ''],
      'مشتری نمونه': ['customer', ''],
    };
    for (const [name, [kind, role]] of Object.entries(expect)) {
      assert.ok(contacts[name], name);
      assert.deepEqual([contacts[name].kind, contacts[name].role], [kind, role], name);
    }
    // ماندهٔ کارت عوض نمی‌شود: حقوقی که به کارمند بدهکاریم همچنان روی کارتش است.
    assert.equal(contacts['کارمند نمونه پرسنل'].balance, -300000);
  });
});

test('دفتری که پیش از اصلاح وارد شده بود ترمیم می‌شود', () => {
  inWorkspace('ترمیم نقش', () => {
    const active = database.activeWorkspaceDatabase();
    importBackup(active);
    completeParsianImport(active, { createdBy: owner.id });
    // حالت قبل از اصلاح: نقش خالی و نوع از سمت حساب.
    active.prepare("UPDATE contacts SET role='',kind='vendor' WHERE name IN ('کارمند نمونه پرسنل','شریک نمونه')").run();
    assert.equal(repairParsianContactRoles(active), 2);
    const contacts = byName();
    assert.deepEqual([contacts['کارمند نمونه پرسنل'].kind, contacts['کارمند نمونه پرسنل'].role], ['person', 'employee']);
    assert.deepEqual([contacts['شریک نمونه'].kind, contacts['شریک نمونه'].role], ['person', 'partner']);
    assert.equal(contacts['شرکت نمونه آلفا'].kind, 'vendor');
  });
});

test('تعریف دستی پرسنل؛ ویرایشی که نقش نمی‌فرستد نقش را پاک نمی‌کند', () => {
  inWorkspace('پرسنل دستی', () => {
    const saved = database.saveContact({ name: 'کارمند دستی نمونه', kind: 'vendor', role: 'employee' });
    assert.deepEqual([saved.kind, saved.role], ['person', 'employee']);
    const edited = database.saveContact({ id: saved.id, name: 'کارمند دستی نمونه', kind: 'person', phone: '09120000000' });
    assert.equal(edited.role, 'employee');
    const cleared = database.saveContact({ id: saved.id, name: 'کارمند دستی نمونه', kind: 'vendor', role: '' });
    assert.deepEqual([cleared.kind, cleared.role], ['vendor', '']);
  });
});
