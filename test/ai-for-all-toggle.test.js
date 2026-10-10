import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase } from './helpers/tempPath.js';
import { minimumRoleForRequest } from '../server/access.js';
import { inUnderstandingScope } from '../shared/understandingScope.js';

/**
 * کلید «همه را اول AI بفهمد» در صفحهٔ ثبت.
 *
 * روشن یعنی هر گفته — ساده یا مرکب، با کارت قطعی یا بی‌آن — اول به فهم رویداد
 * با AI می‌رود و خروجی ساخت‌یافته‌اش به موتور قاعده. کلید فقط همین دو مقدار سیاست
 * را عوض می‌کند و هیچ تنظیم دیگری از دفتر نباید پاک شود.
 */

process.env.DATABASE_PATH = tempDatabase('ai-for-all');
process.env.ADMIN_USERNAME = 'ai-all-owner';
process.env.ADMIN_PASSWORD = 'ai-all-strong-password-7731';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('ai-all-owner', 'ai-all-strong-password-7731');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر کلید AI', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

test('روشن: همه به AI، موتور قاعده روشن؛ بقیهٔ سیاست دفتر دست‌نخورده', () => inWorkspace(() => {
  database.saveAutomationPolicy({ ...database.automationPolicy(), capitalizationThreshold: 30_000_000, autoThreshold: 0.97, neverAutomatic: ['depreciation'] });
  const on = database.setUnderstandingForAll(true);
  assert.equal(on.understandingMode, 'active');
  assert.equal(on.understandingScope, 'all');
  assert.equal(on.engineV2, true);
  assert.equal(on.capitalizationThreshold, 30_000_000);
  assert.equal(on.autoThreshold, 0.97);
  assert.deepEqual([...on.neverAutomatic], ['depreciation']);
}));

test('خاموش: فقط گفته‌های مرکب به AI؛ بقیهٔ سیاست همچنان دست‌نخورده', () => inWorkspace(() => {
  const off = database.setUnderstandingForAll(false);
  assert.equal(off.understandingScope, 'composite');
  assert.equal(off.understandingMode, 'active', 'AI برای گفتهٔ مرکب همچنان در دسترس است');
  assert.equal(off.capitalizationThreshold, 30_000_000);
  assert.equal(off.engineV2, true);
}));

test('تغییر کلید کار مالک یا مدیر است، نه هر ثبت‌کننده', () => {
  assert.equal(minimumRoleForRequest('PUT', '/automation-policy/understanding'), 'manager');
});

test('در حالت «همه»، حتی ساده‌ترین گفته در محدودهٔ AI است', () => {
  for (const text of ['اجاره رو ده میلیون دادیم', '۵۰۰ هزار تومان خرید کردم', 'تنخواه رو شارژ کردیم']) {
    assert.equal(inUnderstandingScope(text, 'all'), true, text);
  }
  assert.equal(inUnderstandingScope('اجاره رو ده میلیون دادیم', 'composite'), false);
});

test('مسیر برنامه: با کلید روشن، AI پیش از هر کارت قطعی اجرا می‌شود', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const route = app.slice(app.indexOf('const routeIntent = (transcript'));
  const aiFirst = route.indexOf('aiForAll.on && aiForAll.ready && online');
  assert.ok(aiFirst > 0, 'کلید در routeIntent بررسی می‌شود');
  for (const deterministic of ['detectPettyCashFunding(', 'detectPartnerPaidDebt(', 'detectSettleIntent(', 'detectVoiceIntent(']) {
    assert.ok(route.indexOf(deterministic) > aiFirst, `${deterministic} بعد از AI است`);
  }
  const today = readFileSync(new URL('../src/features/today/TodayPage.jsx', import.meta.url), 'utf8');
  assert.match(today, /role="switch"/);
  assert.match(today, /همه را اول AI بفهمد/);
});
