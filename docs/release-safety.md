# قرارداد انتشار و کنترل Production

## وضعیت نسخه

`GET /api/health` علاوه بر سلامت سرویس، SHA نسخهٔ در حال اجرا را برمی‌گرداند. در Railway مقدار از `RAILWAY_GIT_COMMIT_SHA` خوانده می‌شود. اگر میزبان این مقدار را ارائه نکند، پاسخ صریحاً `unknown` است و نباید دیپلوی تأییدشده تلقی شود.

## Smoke test

```bash
PRODUCTION_URL=https://hasab-yar-production.up.railway.app \
EXPECTED_SHA=<main-sha> \
EXPECTED_MARKERS='بسته بیشتر از ۴۰۱ ردیف,سقف امن' \
npm run smoke:production
```

این کنترل چهار چیز را تطبیق می‌دهد: پاسخ health، SHA دیپلوی، نام JavaScript فعال در `index.html` و حضور نشانه‌های قابلیت در همان bundle.

Workflow «کنترل Production» همین فرمان را به‌صورت دستی اجرا می‌کند و برای اتصال به webhook پایان دیپلوی Railway آماده است.

## حفاظت `main`

در GitHub، Ruleset شاخهٔ `main` باید با این قواعد فعال شود:

- Pull request پیش از ورود به `main` الزامی؛
- Required status check با نام `test-and-build`؛
- شاخه باید پیش از merge به‌روز باشد؛
- force push و حذف شاخه ممنوع؛
- عبور مدیر از قواعد غیرفعال؛
- حداقل یک تأیید برای تغییرات حساس Production.

فعال‌کردن Ruleset یک تغییر تنظیمات مخزن است و داخل commit قابل اعمال نیست؛ باید یک‌بار از تنظیمات GitHub انجام شود.

## وابستگی‌های زمان اجرا و ابزار build

ابزارهای ساخت رابط — Vite، افزونهٔ React، Tailwind، PostCSS، Autoprefixer و concurrently — در `devDependencies` هستند، نه `dependencies`. سرور در حال اجرا هیچ‌کدام را import نمی‌کند؛ فقط `dist` ساخته‌شده را سرو می‌کند. ممیزی امنیتی Production (`npm audit --omit=dev`) به همین دلیل فقط وابستگی‌هایی را می‌سنجد که واقعاً روی سرور اجرا می‌شوند.

پیش‌شرط: مرحلهٔ build میزبان باید `devDependencies` را نصب کند (رفتار پیش‌فرض Railway برای پروژهٔ Node که اسکریپت `build` دارد). اگر روزی build با خطای «vite: not found» شکست خورد، علتش حذف وابستگی‌های dev در مرحلهٔ نصب است؛ build ناموفق دیپلوی فعلی را جایگزین نمی‌کند.

زنجیرهٔ Tailwind 3 هنوز `braces` و `postcss-selector-parser` آسیب‌پذیر دارد. هر دو فقط هنگام build روی فایل‌های خودِ مخزن اجرا می‌شوند و ورودی کاربر به آن‌ها نمی‌رسد. `braces` هیچ نسخهٔ رفع‌شده‌ای ندارد؛ رفع کامل، مهاجرت به Tailwind 4 است که جدا انجام می‌شود.
