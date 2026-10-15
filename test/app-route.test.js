import test from 'node:test';
import assert from 'node:assert/strict';
import { readRoute, routeHash } from '../src/app/route.js';
import { MENU, LEDGER_SECTIONS } from '../src/app/menu.js';

/**
 * نشانی صفحه‌ها: «بازگشت» مرورگر، تازه‌سازی و پیوند به هر بخش.
 * هر برگ منو یک نشانی دارد که همان برگ را برمی‌گرداند.
 */
test('نشانی هر برگ منو همان صفحه و بخش را برمی‌گرداند', () => {
  for (const group of MENU) {
    for (const item of group.items) {
      const route = readRoute(routeHash(item.screen, item.section || ''));
      assert.deepEqual(route, { screen: item.screen, section: item.section || '' }, item.label);
    }
  }
  assert.equal(LEDGER_SECTIONS[readRoute('#/ledger/timing').section], 'timing');
});

test('نشانی خراب یا ساختگی چیزی جز شناسهٔ ساده نمی‌دهد', () => {
  assert.deepEqual(readRoute(''), { screen: '', section: '' });
  assert.deepEqual(readRoute('#/'), { screen: '', section: '' });
  assert.deepEqual(readRoute('#/ledger/<script>'), { screen: 'ledger', section: 'script' });
  assert.deepEqual(readRoute('#/%E0%A4%A'), { screen: '', section: '' });
  assert.deepEqual(readRoute('#today'), { screen: 'today', section: '' });
});
