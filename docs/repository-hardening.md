# راهنمای سخت‌سازی Repository حسب‌یار

این سند تنظیماتی را مشخص می‌کند که بخشی از Git نیستند و باید در تنظیمات GitHub اعمال شوند.

## وضعیت اعمال‌شده در کد

- اکشن‌های رسمی GitHub و Gitleaks با SHA قطعی Pin شده‌اند.
- تست، Build، اسکن Secret و Audit وابستگی Production Workflow مستقل دارند.
- Dependabot برای npm و GitHub Actions فعال می‌شود.
- CODEOWNERS و چک‌لیست Pull Request اضافه شده‌اند.
- اکشن Checkout اجازه نگهداری Credential برای Push بعدی ندارد.

## Ruleset پیشنهادی برای main

در Settings → Rules → Rulesets یک Ruleset برای شاخه `main` بساز:

1. Require a pull request before merging
2. Require status checks to pass
3. Require branches to be up to date before merging
4. Block force pushes
5. Restrict deletions
6. Require conversation resolution
7. Status checkهای اجباری:
   - `test-and-build`
   - `gitleaks`
   - `production-dependency-audit`

تا وقتی پروژه فقط یک Maintainer دارد، الزام Approval انسانی می‌تواند همه PRها را
قفل کند. پس فعلاً صفر Approval اجباری باشد؛ با اضافه‌شدن بازبین دوم، یک Approval
و سپس Require review from Code Owners فعال شود.

Admin bypass فقط برای بازیابی اضطراری نگه داشته شود و استفاده از آن مستند شود.

## تنظیمات امنیتی GitHub

در Settings → Code security and analysis، در صورت پشتیبانی Plan فعال شوند:

- Private vulnerability reporting
- Dependabot alerts
- Dependabot security updates
- Secret scanning
- Push protection

## بدهی شناخته‌شده تاریخچه

مستندات قبلی اعلام کرده‌اند که ردپای نام مشتری، مبلغ و شناسه‌های واقعی از فایل‌های
فعلی حذف شده اما تاریخچه بازنویسی نشده است. Gitleaks برای Secret مناسب است، اما
جایگزین بررسی PII یا پاک‌سازی تاریخچه نیست.

بازنویسی تاریخچه فقط با تأیید جداگانه انجام شود:

1. تهیه Mirror backup از Repository
2. تهیه فهرست دقیق PII و Secret
3. Rotate یا Revoke کردن Secretها
4. اجرای `git filter-repo` روی Mirror آزمایشی
5. مقایسه Tag، Branch و Build
6. Force push هماهنگ
7. حذف یا بی‌اعتبارکردن Cloneهای قبلی
8. بررسی Actions artifact، Release و Cache

## معیار پایان فاز

این فاز زمانی کاملاً بسته است که PR امنیتی Merge شود، سه Status check سبز باشند،
Ruleset روی `main` فعال شده باشد و GitHub دیگر Push مستقیم یا Force push را نپذیرد.
