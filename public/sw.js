// با هر تغییر در راهبرد کش، نسخه بالا می‌رود تا کش قدیمی در activate پاک شود.
const SHELL_CACHE = 'hesab-yar-shell-v5';
const ASSET_CACHE = 'hesab-yar-assets-v5';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg'];
// کلید ساختگی داخل کش؛ هیچ درخواست واقعی با آن برابر نمی‌شود.
const GENERATION_KEY = '/__asset-generation';

/**
 * فایل‌هایی که hash محتوا در نامشان است، از کش خوانده می‌شوند نه از شبکه.
 *
 * تا امروز این service worker برای *همه‌چیز* network-first بود و کش فقط وقتی
 * به کار می‌آمد که شبکه شکست بخورد. یعنی همان بستهٔ ۷۱۲ کیلوبایتی که نامش
 * `index-<hash>.js` است و محتوایش هرگز عوض نمی‌شود، در هر بار باز کردن
 * برنامه دوباره از شبکه گرفته می‌شد. سرور برای همین فایل‌ها
 * `max-age=31536000, immutable` می‌فرستد و این کد جلوی آن را می‌گرفت.
 *
 * اثرش روی میزبانی که سرویس را می‌خواباند بیشترین است: کاربری که ساعت ۹ وارد
 * شده و ۱۱ برمی‌گردد، باز هم باید منتظر بیدار شدن سرور بماند تا اولین چیز را
 * ببیند — درحالی‌که همان بستهٔ دقیقاً یکسان روی دستگاهش بوده است.
 *
 * سند HTML عمداً از این قاعده بیرون است و همچنان network-first می‌ماند، وگرنه
 * دیپلوی تازه دیده نمی‌شد. چون هر دیپلوی hash تازه می‌سازد، سندِ تازه به‌طور
 * خودکار به نشانی‌های تازه اشاره می‌کند و کش قدیمی بی‌اثر می‌شود.
 */
const isHashedAsset = (url) => url.origin === self.location.origin && url.pathname.startsWith('/assets/');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL_CACHE, ASSET_CACHE];
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => !keep.includes(key)).map((key) => caches.delete(key)))));
  self.clients.claim();
});

/**
 * کش دارایی‌ها بین دیپلوی‌ها بی‌پایان بزرگ نشود.
 *
 * پاک‌کردن «هر چیزی که در HTML تازه نیست» غلط می‌بود: قطعه‌های تنبل
 * (`import()`) اصلاً در HTML نمی‌آیند و هر بار دور ریخته می‌شدند. به‌جایش
 * نشانی بستهٔ اصلی به‌عنوان شناسهٔ نسل نگه داشته می‌شود؛ تا وقتی عوض نشده
 * یعنی همان دیپلوی است و همهٔ قطعه‌هایش معتبرند، و تا عوض شد یعنی دیپلوی
 * تازه‌ای آمده و کل نسل قبلی مرده است.
 */
async function dropReplacedGeneration(html) {
  const current = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!current) return;
  const cache = await caches.open(ASSET_CACHE);
  const previous = await cache.match(GENERATION_KEY).then((response) => (response ? response.text() : ''));
  if (previous === current) return;
  for (const request of await cache.keys()) await cache.delete(request);
  await cache.put(GENERATION_KEY, new Response(current));
}

async function fromCacheFirst(request, event) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // پاسخ ناقص یا خطادار نباید یک سال در کش بماند.
  if (response.ok) event.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function fromNetworkFirst(request, event) {
  try {
    const response = await fetch(request);
    // نوشتن در کش و پاک‌سازی نسل هیچ‌کدام نباید پاسخ را نگه دارند؛ `waitUntil`
    // فقط service worker را تا پایانشان زنده نگه می‌دارد. پیش از این پاک‌سازی
    // `await` می‌شد و دقیقاً همان تأخیری را می‌ساخت که قرار بود از بین برود.
    const forCache = response.clone();
    event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(request, forCache)));
    if (request.destination === 'document' && response.ok) {
      event.waitUntil(response.clone().text().then(dropReplacedGeneration).catch(() => {}));
    }
    return response;
  } catch (error) {
    const cached = (await caches.match(request)) || (await caches.match('/'));
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin || !['document', 'script', 'style', 'image', 'font'].includes(request.destination)) return;
  event.respondWith(isHashedAsset(url) ? fromCacheFirst(request, event) : fromNetworkFirst(request, event));
});
