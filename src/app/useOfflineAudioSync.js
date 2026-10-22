// همگام‌سازی پس از اتصال: ثبت‌های آفلاین صف و صداهای ذخیره‌شدهٔ همین کاربر و همین
// دفتر، و شمار صداهای منتظر.
//
// از src/App.jsx جدا شد؛ متن توابع و effectها دست نخورده است. App این قلاب را در
// هر رندر با مقدارهای همان رندر صدا می‌زند، پس هر closure همان چیزی را می‌بیند که
// پیش‌تر درون App می‌دید.

import { useEffect } from 'react';
import { api, flushTransactionQueue } from '../lib/api.js';
import { countOfflineAudio, failOfflineAudio, markOfflineAudioForReview, pendingAudio } from '../lib/offlineAudio.js';
import { isNetworkQueueError, isPermanentQueueError } from '../lib/offlineScope.js';
import { toPersianDigits } from '../lib/format.js';

export function useOfflineAudioSync({ online, authenticated, offlineScopeReady, offlineUserId, offlineWorkspaceId, parseResult, setParseResult, setPendingAudioCount, load, notify }) {
  useEffect(() => {
    if (!online || !authenticated || !offlineScopeReady || parseResult) return undefined;
    let active = true;
    const scope = { userId: offlineUserId, workspaceId: offlineWorkspaceId };
    (async () => {
      const syncResult = await flushTransactionQueue(scope).catch(() => ({ synced: 0, failed: 0, pending: 0 }));
      const audios = await pendingAudio(scope).catch(() => []);
      if (active) setPendingAudioCount(await countOfflineAudio(scope).catch(() => 0));
      // فقط یک نتیجه در هر نوبت به کاربر نشان داده می‌شود، ولی قلم شکست‌خورده
      // نباید بقیهٔ صف را پشت خودش نگه دارد: تا امروز یک ضبط پردازش‌نشدنی
      // بی‌پایان تکرار می‌شد و همهٔ ضبط‌های بعدی هرگز نوبتشان نمی‌رسید.
      let giveUpCount = 0;
      for (const item of audios) {
        try {
          const result = await api.parseAudio(item.blob, { workspaceId: scope.workspaceId });
          if (!result.transactions?.length) {
            // متن شنیده شد ولی مبلغی نداشت؛ تکرارش هم همین نتیجه را می‌دهد.
            const outcome = await failOfflineAudio(item.id, scope, 'مبلغی در این صدا پیدا نشد.', { permanent: true });
            if (outcome?.exhausted) giveUpCount += 1;
            continue;
          }
          await markOfflineAudioForReview(item.id, scope);
          if (active) {
            setParseResult({ ...result, offlineAudioId: item.id });
            notify('صدای ذخیره‌شده پردازش شد؛ پس از تأیید ثبت می‌شود.');
          }
          break;
        } catch (error) {
          // سرور در دسترس نیست: نه تلاشی انجام شده که شمرده شود، نه فرستادن
          // بقیهٔ صف فایده‌ای دارد. `navigator.onLine` این حالت را نمی‌گیرد —
          // دستگاه اینترنت دارد و این سرور است که جواب نمی‌دهد — و چون شکست
          // شبکه هم یک تلاش حساب می‌شد، سه بار بازکردن برنامه روی میزبانی که
          // هنوز بیدار نشده بود کافی بود تا یک ضبط کاملاً سالم `failed` شود.
          if (isNetworkQueueError(error)) break;
          const outcome = await failOfflineAudio(item.id, scope, error?.message || 'خطای پردازش صوت', {
            permanent: isPermanentQueueError(error),
          }).catch(() => null);
          if (outcome?.exhausted) giveUpCount += 1;
          // خطای شبکه یعنی بقیهٔ صف هم همین حالا شکست می‌خورد؛ ادامه بی‌فایده است.
          if (!navigator.onLine) break;
        }
      }
      if (active && giveUpCount) {
        notify(`${toPersianDigits(giveUpCount)} صدای ذخیره‌شده پردازش نشد و از صف خارج شد؛ همان‌ها را دستی ثبت کن.`);
      }
      if (active && syncResult.synced) {
        notify(`${toPersianDigits(syncResult.synced)} ثبت آفلاین همگام شد.`);
        load();
      } else if (active && syncResult.failed) {
        notify(`${toPersianDigits(syncResult.failed)} ثبت آفلاین نیازمند بررسی است و خودکار تکرار نمی‌شود.`);
      }
    })();
    return () => { active = false; };
  }, [online, authenticated, offlineScopeReady, offlineUserId, offlineWorkspaceId, parseResult, load, notify]);

  useEffect(() => {
    if (!authenticated || !offlineScopeReady) { setPendingAudioCount(0); return undefined; }
    countOfflineAudio({ userId: offlineUserId, workspaceId: offlineWorkspaceId })
      .then(setPendingAudioCount).catch(() => setPendingAudioCount(0));
    return undefined;
  }, [authenticated, offlineScopeReady, offlineUserId, offlineWorkspaceId]);
}
