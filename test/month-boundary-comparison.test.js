import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * روز آخر ماه، شمارش‌های میز کار صفر می‌شد.
 *
 * `datetime('2026-09-22T20:30:00.000Z')` رشتهٔ «2026-09-22 20:30:00» می‌دهد —
 * با فاصله. ولی ستون `occurred_at` همان ISO با «T» را نگه می‌دارد. مقایسهٔ این
 * دو در SQLite متنی است و «T» از فاصله بزرگ‌تر است، پس هر ثبتی که تاریخ
 * میلادی‌اش با تاریخ پایان بازه یکی بود از بازه بیرون می‌افتاد.
 *
 * بقیهٔ روزها بخش تاریخ فرق داشت و مقایسه درست درمی‌آمد؛ فقط روز آخرِ هر ماه
 * شمسی خراب می‌شد. یعنی میز کار دفتر، دقیقاً در روزی که حسابدار بسته را
 * می‌بندد، همه‌چیز را صفر نشان می‌داد.
 */
test('مقایسهٔ متنیِ ISO با خروجی datetime، روز مرزی را می‌اندازد', () => {
  const database = new DatabaseSync(':memory:');
  const stored = '2026-09-22T05:20:59.901Z';
  const bound = '2026-09-22T20:30:00.000Z';
  // ریشهٔ مشکل، این‌جاست و باید دیده شود:
  assert.equal(database.prepare(`SELECT ('${stored}' < datetime('${bound}')) AS v`).get().v, 0);
  // و راه‌حل، یکی‌کردن شکل هر دو طرف:
  assert.equal(database.prepare(`SELECT (datetime('${stored}') < datetime('${bound}')) AS v`).get().v, 1);
});

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.js$/.test(name) ? [full] : [];
  });
}

/**
 * هیچ پرس‌وجویی نباید ستون خام را با خروجی `datetime()` بسنجد.
 *
 * دوازده جا همین یک ایراد را داشتند. آزمون ایستا، برگشتنش را می‌گیرد — چون
 * این خطا فقط یک روز در ماه خودش را نشان می‌دهد و تا ماه بعد دیده نمی‌شود.
 */
test('هیچ ستونی بدون datetime با datetime مقایسه نمی‌شود', () => {
  const offenders = [];
  for (const file of sourceFiles('server')) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      // ستونی که خودش در datetime() پیچیده نشده، در برابر datetime(?)
      if (/(?<!datetime\()\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?\s*(?:>=|<=|<|>)\s*datetime\(\?\)/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `هر دو طرف مقایسه باید datetime() باشند:\n${offenders.join('\n')}`);
});
