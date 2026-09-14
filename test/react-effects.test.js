import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(jsx?|mjs)$/.test(name) ? [full] : [];
  });
}

/**
 * تابعی که به useEffect داده می‌شود، هرچه برگرداند React آن را پاک‌سازی می‌پندارد.
 *
 * «useEffect(load, [])» با loadی که Promise برمی‌گرداند باعث شد با ترک صفحهٔ
 * «یادگیری‌ها» کل برنامه با «is not a function» از کار بیفتد. این خطا در build
 * دیده نمی‌شود و فقط هنگام جابه‌جایی صفحه در مرورگر رخ می‌دهد.
 */
test('هیچ useEffectی تابع نام‌دار را مستقیم نمی‌گیرد', () => {
  const offenders = [];
  for (const file of sourceFiles('src')) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/useEffect\(\s*[A-Za-z_$][\w$]*\s*[,)]/.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'بدنه را در آکولاد بپیچ: useEffect(() => { load(); }, [])');
});
