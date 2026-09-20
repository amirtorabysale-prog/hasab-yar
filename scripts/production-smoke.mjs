const baseUrl = String(process.env.PRODUCTION_URL || process.argv[2] || '').replace(/\/$/, '');
const expectedSha = String(process.env.EXPECTED_SHA || process.argv[3] || '').trim().toLowerCase();
const markers = String(process.env.EXPECTED_MARKERS || '').split(',').map((item) => item.trim()).filter(Boolean);

if (!/^https?:\/\//.test(baseUrl)) throw new Error('PRODUCTION_URL باید یک نشانی کامل http/https باشد.');
if (expectedSha && !/^[0-9a-f]{7,40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA معتبر نیست.');

const get = async (path) => {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path} با وضعیت ${response.status} پاسخ داد.`);
  return response;
};

const health = await (await get('/api/health')).json();
if (health.ok !== true) throw new Error('/api/health سالم نیست.');
if (expectedSha && !String(health.release?.sha || '').startsWith(expectedSha) && !expectedSha.startsWith(String(health.release?.sha || ''))) {
  throw new Error(`SHA پروداکشن ${health.release?.sha || 'نامشخص'} با ${expectedSha} تطبیق ندارد.`);
}

const html = await (await get('/')).text();
const assetPath = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
if (!assetPath) throw new Error('فایل JavaScript فعال از index.html پیدا نشد.');
const assetUrl = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
const entry = await (await get(assetUrl)).text();
if (entry.length < 10_000) throw new Error('فایل JavaScript فعال به‌طور غیرعادی کوچک است.');

/**
 * نشانهٔ قابلیت می‌تواند در هر قطعه‌ای باشد، نه فقط در بستهٔ اصلی.
 *
 * تا وقتی همهٔ صفحه‌ها در یک بسته بودند، گشتن در همان یکی کافی بود. با
 * تقسیم بسته، «بسته بیشتر از ۴۰۱ ردیف» به قطعهٔ همکاری حسابدار رفت و «سقف
 * امن» به قطعهٔ کدینگ — و این کنترل قرمز شد درحالی‌که هر دو قابلیت سالم روی
 * production بودند. یک کنترل انتشار که دیپلوی درست را رد کند، به‌زودی
 * نادیده گرفته می‌شود و آن‌وقت دیگر چیزی را نمی‌گیرد.
 *
 * نشانی قطعه‌ها به‌صورت رشته داخل خود بستهٔ اصلی است، چون `import()` پویا
 * بعد از build به همان نشانی‌ها تبدیل می‌شود.
 */
const chunkUrls = [...new Set(
  [...entry.matchAll(/["'`]((?:\.?\/)?assets\/[A-Za-z0-9_$.-]+\.js)["'`]/g)]
    .map((match) => `/${match[1].replace(/^\.?\//, '')}`)
    .filter((url) => url !== assetUrl),
)];
const chunks = await Promise.all(chunkUrls.map(async (url) => (await get(url)).text()));
const javascript = [entry, ...chunks].join('\n');

for (const marker of markers) if (!javascript.includes(marker)) throw new Error(`نشانهٔ قابلیت «${marker}» در هیچ‌یک از ${1 + chunks.length} قطعهٔ JavaScript نیست.`);

console.log(JSON.stringify({ ok: true, sha: health.release?.sha || 'unknown', asset: assetUrl, chunks: chunks.length, markers }, null, 2));
