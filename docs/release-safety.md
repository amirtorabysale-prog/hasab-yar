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
