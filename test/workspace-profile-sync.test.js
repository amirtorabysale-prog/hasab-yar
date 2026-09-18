import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { experienceForRole, screensFor } from '../shared/experience.js';

const databasePath = tempDatabase('profile-sync');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'profile-owner';
process.env.ADMIN_PASSWORD = 'Profile-Long-Passphrase-5521';

const database = await import(`../server/db.js?profile=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('profile-owner', 'Profile-Long-Passphrase-5521');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر نوع', profileType: 'personal' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const menu = () => {
  const membership = database.workspaceForUser(owner.id, workspace.id);
  return screensFor({
    role: membership.role,
    experience: experienceForRole(membership.role, 'professional'),
    profileType: membership.profileType,
  }).map((item) => item.id);
};

/**
 * نوع دفتر در دو جا بود و فقط یکی به‌روز می‌شد.
 *
 * کاربر در تنظیمات «کسب‌وکار» را انتخاب می‌کرد، ولی منو هنوز از روی ردیفی ساخته
 * می‌شد که «شخصی» مانده بود؛ پس «همکاری حسابدار» — جای خروجی پارسیان — هیچ‌وقت
 * در منو نمی‌آمد و هیچ پیامی هم نمی‌گفت چرا.
 */
test('تغییر نوع دفتر در تنظیمات، منو را هم عوض می‌کند', () => {
  database.setExperiencePreference(workspace.id, owner.id, 'professional');
  assert.ok(!menu().includes('collaboration'), 'دفتر شخصی خروجی پارسیان ندارد');

  inWorkspace(() => database.saveSettings({ profileType: 'business' }));
  assert.equal(database.workspaceForUser(owner.id, workspace.id).profileType, 'business');
  assert.ok(menu().includes('collaboration'), 'پس از انتخاب «کسب‌وکار»، خروجی پارسیان باید در منو باشد');

  inWorkspace(() => database.saveSettings({ profileType: 'personal' }));
  assert.ok(!menu().includes('collaboration'));
});

// مقدار نامعتبر پیش از این بی‌صدا ذخیره می‌شد و هر دو نسخه را از معنا می‌انداخت.
test('نوع دفتر نامعتبر رد می‌شود', () => {
  assert.throws(() => inWorkspace(() => database.saveSettings({ profileType: 'company' })), /نوع دفتر معتبر نیست/);
});

// دفتر تازه مقدار پیش‌فرض «کسب‌وکار» را در تنظیمات دارد؛ اگر آن مرجع شمرده شود،
// دفتر شخصی تازه‌ساخته همان لحظهٔ باز شدن کسب‌وکار می‌شود.
test('دفتر شخصیِ تازه‌ساخته شخصی می‌ماند', () => {
  const fresh = database.createWorkspace(owner.id, { name: 'دفتر شخصی تازه', profileType: 'personal' });
  assert.equal(database.workspaceForUser(owner.id, fresh.id).profileType, 'personal');
});

test.after(() => removeTempDatabase(databasePath));
