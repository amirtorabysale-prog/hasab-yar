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
const javascript = await (await get(assetUrl)).text();
if (javascript.length < 10_000) throw new Error('فایل JavaScript فعال به‌طور غیرعادی کوچک است.');
for (const marker of markers) if (!javascript.includes(marker)) throw new Error(`نشانهٔ قابلیت «${marker}» در JavaScript فعال نیست.`);

console.log(JSON.stringify({ ok: true, sha: health.release?.sha || 'unknown', asset: assetUrl, markers }, null, 2));
