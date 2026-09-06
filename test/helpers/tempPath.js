import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * پوشهٔ یکتا برای دیتابیس هر فایل آزمون.
 *
 * تا امروز نام فایل فقط از PID ساخته می‌شد و مستقیم در `/tmp` می‌نشست. دو ایراد
 * داشت و هر دو شکستِ یک‌باره و بازتولیدنشدنی می‌سازند:
 *
 * ۱. پاک‌سازی فقط در `test.after()` انجام می‌شود؛ اجرایی که نیمه‌کاره می‌مرد
 *    (Ctrl-C، timeout، kill) فایلش را جا می‌گذاشت و سیستم‌عامل همان PID را دیر یا
 *    زود دوباره به همان فایل آزمون می‌داد. آن اجرا روی دیتابیس از پیش پرشده شروع
 *    می‌شد، شمارش و جمع‌ها یک‌بار غلط می‌شدند، و چون همان اجرا فایل را پاک می‌کرد
 *    اجرای بعدی سالم بود.
 * ۲. دیتابیس هر دفتر در `dirname(databasePath)/workspaces/<id>.sqlite` ساخته
 *    می‌شود. با نشستن همهٔ فایل‌ها در `/tmp`، این پوشه میان فایل‌های آزمونی که
 *    `node --test` هم‌زمان اجرا می‌کند مشترک بود و شناسهٔ یکسان دفتر یعنی دو
 *    پروسه روی یک فایل.
 *
 * پوشهٔ تصادفی هر دو را می‌بندد: هر اجرا فضای خودش را دارد، چه اجرای قبلی تمیز
 * تمام شده باشد چه نه.
 */
export function tempDatabase(name) {
  return join(mkdtempSync(join(tmpdir(), `hesab-yar-${name}-`)), 'db.sqlite');
}

/** کل پوشهٔ موقت را برمی‌دارد؛ فایل‌های `-wal`، `-shm` و دیتابیس دفترها هم با آن می‌روند. */
export function removeTempDatabase(databasePath) {
  rmSync(dirname(databasePath), { recursive: true, force: true });
}
