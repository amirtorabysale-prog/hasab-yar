# کیت پایلوت انتقال حساب‌یار به پارسیان

این کیت برای اجرای کنترل‌شدهٔ فاز ۸ روی یک رایانهٔ ویندوزی دارای SQL Server و پارسیان است. هیچ اسکریپتی اطلاعات مالی را به اینترنت ارسال نمی‌کند.

## قواعد ایمنی

- فقط روی یک نسخهٔ کپی‌شده از بکاپ و یک شرکت آزمایشی اجرا کن.
- دیتابیس اصلی دفتر یا مشتری را هدف قرار نده.
- اسکریپت Restore اگر دیتابیس مقصد از قبل وجود داشته باشد متوقف می‌شود و از `WITH REPLACE` استفاده نمی‌کند.
- فایل بکاپ و خروجی‌های دارای اطلاعات مالی را در GitHub، پیام‌رسان عمومی یا سرویس آنلاین بارگذاری نکن.
- موفقیت Dry Run به معنی سازگاری نیست؛ فقط Trial Import واقعی با تعداد ردیف و جمع‌های کاملاً برابر پذیرفته می‌شود.

## پیش‌نیاز

1. ویندوزی که همان نسخهٔ پارسیان روی آن نصب است.
2. SQL Server و ابزار `sqlcmd`.
3. یک شرکت آزمایشی خالی در پارسیان.
4. فایل خروجی CSV فاز ۷ حساب‌یار.

## ترتیب اجرا

PowerShell را با دسترسی معمولی باز کن و وارد پوشهٔ کیت شو.

### ۱. بررسی بکاپ بدون Restore

```powershell
.\01-Inspect-ParsianBackup.ps1 -BackupPath "C:\ParsianPilot\db_1402.bak" -ServerInstance ".\SQLEXPRESS"
```

خروجی‌های `VERIFYONLY`، `HEADERONLY` و `FILELISTONLY` در پوشهٔ `evidence` ذخیره می‌شوند. اگر `VERIFYONLY` موفق نشد، ادامه نده.

### ۲. Restore ایزوله

نام‌های منطقی پیش‌فرض از فایل نمونه استخراج شده‌اند: `db_13851_Data` و `db_13851_Log`. اگر `FILELISTONLY` نام دیگری نشان داد، پارامترها را عوض کن.

```powershell
.\02-Restore-ParsianSandbox.ps1 `
  -BackupPath "C:\ParsianPilot\db_1402.bak" `
  -ServerInstance ".\SQLEXPRESS" `
  -DatabaseName "ParsianPilot_1402" `
  -IUnderstandThisCreatesDatabase
```

### ۳. استخراج Schema بدون دادهٔ مالی

```powershell
.\03-Export-ParsianSchema.ps1 -ServerInstance ".\SQLEXPRESS" -DatabaseName "ParsianPilot_1402"
```

فایل‌های خروجی فقط نام جدول، ستون، نوع داده و کلیدها را نگه می‌دارند؛ مقادیر تراکنش‌ها صادر نمی‌شوند.

### ۴. Trial Import در خود پارسیان

CSV حساب‌یار را ابتدا روی شرکت آزمایشی وارد یا طبق قالب پارسیان نگاشت کن. سپس تعداد ردیف واردشده، ردیف ردشده و جمع بدهکار/بستانکار مقصد را از پارسیان بردار.

```powershell
.\04-Test-HasabYarTrialImport.ps1 `
  -CsvPath "C:\ParsianPilot\hesab-yar-1405-05.csv" `
  -ParsianVersion "نسخه دقیق نمایش‌داده‌شده در پارسیان" `
  -TestCompanyLabel "شرکت آزمایشی الف" `
  -AmountUnit rial `
  -ImportedRows 20 `
  -RejectedRows 0 `
  -ImportedDebitTotal 125000000 `
  -ImportedCreditTotal 125000000
```

اسکریپت فایل `phase8-evidence.json` می‌سازد. فقط اگر `outcome` برابر `passed` بود، نتیجه را در صفحهٔ «همکاری حسابدار ← پل نرم‌افزار حسابداری ← ثبت آزمون» با نوع «ورود آزمایشی واقعی» ثبت کن.

## معیار پایان فاز ۸

- `VERIFYONLY` موفق؛
- نسخهٔ دقیق پارسیان ثبت‌شده؛
- شرکت آزمایشی غیرمحرمانه مشخص؛
- تعداد ردیف مقصد دقیقاً برابر CSV؛
- ردیف ردشده صفر؛
- جمع بدهکار و بستانکار مقصد دقیقاً برابر CSV با واحد یکسان؛
- فایل evidence و SHA-256 خروجی نگه‌داری‌شده؛
- پذیرش نهایی فقط بعد از Trial Import موفق.

