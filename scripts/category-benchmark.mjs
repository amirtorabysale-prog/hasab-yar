/**
 * سنجش دسته روی مسیر بدون هوش مصنوعی (پارسر و موتور، همان `runVoice`).
 *
 * هر جمله‌ی `docs/testing/category-benchmark.json` از همان مسیر برنامه می‌گذرد و
 * دسته‌ی هر ردیف با دسته‌های پذیرفتنیِ از پیش نوشته‌شده سنجیده می‌شود:
 *   درست      همه‌ی ردیف‌ها دسته‌ی پذیرفتنی دارند
 *   غلطِ بی‌صدا  دسته‌ی ناپذیرفتنی و ثبت با یک تأیید (خطرناک‌ترین)
 *   غلطِ متوقف  دسته‌ی ناپذیرفتنی ولی سؤال یا صف حسابدار
 * اجرا: `node scripts/category-benchmark.mjs [--json]`
 */
import { readFileSync } from 'node:fs';
import { runVoice } from '../test/helpers/voicePipeline.js';

const bench = JSON.parse(readFileSync(new URL('../docs/testing/category-benchmark.json', import.meta.url), 'utf8'));
const rows = [];
for (const [id, group, text, accept] of bench.items) {
  const result = runVoice(text, { today: '2026-10-14T08:00:00.000Z' });
  const items = (result.items || []).filter((item) => item.category);
  // حساب واقعی سند مهم‌تر از برچسب دسته است: خریدی که موجودی کالا یا دارایی ثابت شد،
  // همان است، هر برچسبی که داشته باشد.
  const categoryOf = (item) => {
    const roles = (item.plan?.lines || []).filter((line) => line.debit).map((line) => line.role);
    if (roles.includes('inventory-unsplit')) return 'مواد و کالا';
    if (roles.includes('fixed-asset')) return 'دارایی ثابت';
    return item.category;
  };
  const categories = items.map(categoryOf);
  const ok = categories.length > 0 && categories.every((category) => accept.includes(category));
  const posted = items.some((item) => item.outcome === 'post' && !accept.includes(categoryOf(item)));
  rows.push({ id, group, text, accept, categories, outcomes: items.map((item) => item.outcome), verdict: !categories.length ? 'no-row' : ok ? 'correct' : posted ? 'wrong-silent' : 'wrong-stopped' });
}
const tally = (list) => list.reduce((map, row) => ({ ...map, [row.verdict]: (map[row.verdict] || 0) + 1 }), {});
const groups = [...new Set(rows.map((row) => row.group))];
if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
console.log('کل:', rows.length, tally(rows));
for (const group of groups) console.log(group.padEnd(8), tally(rows.filter((row) => row.group === group)));
console.log('\nغلط‌ها:');
for (const row of rows.filter((item) => item.verdict.startsWith('wrong'))) console.log(row.verdict === 'wrong-silent' ? '!!' : '  ', row.id, row.categories.join('+'), '←', row.text.slice(0, 60));
