import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { canChooseExperience, experienceForRole, pathNeedsProfessional, screensFor } from '../shared/experience.js';
import { minimumRoleForRequest } from '../server/access.js';

const databasePath = tempDatabase('experience-switch');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'switch-admin';
process.env.ADMIN_PASSWORD = 'Switch-Long-Passphrase-7314';

const database = await import(`../server/db.js?switch=${process.pid}`);
database.ensureAdmin();

const admin = database.authenticateUser('switch-admin', 'Switch-Long-Passphrase-7314');
const workspace = database.createWorkspace(admin.id, { name: 'دفتر آزمایشی', profileType: 'business' });

const screensOf = (userId, workspaceId) => {
  const membership = database.workspaceForUser(userId, workspaceId);
  const experience = experienceForRole(membership.role, membership.experiencePreference);
  return screensFor({ role: membership.role, experience, profileType: 'business' }).map((item) => item.id);
};

/**
 * خروجی پارسیان در صفحهٔ «همکاری حسابدار» است و آن صفحه فقط در محیط حرفه‌ای.
 *
 * مالک به‌طور پیش‌فرض در محیط ساده است و تا پیش از این هیچ راهی برای رفتن به
 * محیط حرفه‌ای نداشت — مگر اینکه دقیقاً همان کاربر ADMIN_USERNAME روی سرور
 * باشد. هر مالکِ دیگری، مثل مالک دفتری که خودش ساخته، خروجی را هیچ‌وقت نمی‌دید.
 */
test('مالکِ دفترِ تازه در ابتدا خروجی پارسیان را نمی‌بیند', () => {
  assert.ok(!screensOf(admin.id, workspace.id).includes('collaboration'));
});

test('مالک با رفتن به محیط حرفه‌ای به خروجی پارسیان می‌رسد', () => {
  database.setExperiencePreference(workspace.id, admin.id, 'professional');
  const screens = screensOf(admin.id, workspace.id);
  assert.ok(screens.includes('collaboration'), 'همکاری حسابدار — جای خروجی پارسیان — باید در منو باشد');
  assert.ok(screens.includes('review'));
});

test('و می‌تواند به محیط ساده برگردد', () => {
  database.setExperiencePreference(workspace.id, admin.id, 'simple');
  assert.ok(!screensOf(admin.id, workspace.id).includes('collaboration'));
});

// کسی که در محیط ساده گیر افتاده باید بتواند از آن بیرون بیاید؛ اگر این مسیر هم
// پشت مرز حرفه‌ای بود، دری که کلیدش پشت همان در است.
test('مسیر تغییر محیط در محیط ساده باز است', () => {
  assert.equal(pathNeedsProfessional('/workspace/experience'), false);
  assert.equal(minimumRoleForRequest('PUT', '/workspace/experience'), 'accountant');
});

test('فقط مالک محیطش را انتخاب می‌کند', () => {
  assert.equal(canChooseExperience('owner'), true);
  for (const role of ['manager', 'accountant', 'viewer']) assert.equal(canChooseExperience(role), false, role);
});

test.after(() => removeTempDatabase(databasePath));
