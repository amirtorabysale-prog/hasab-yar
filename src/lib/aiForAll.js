/**
 * وضعیت کلید «همه را اول AI بفهمد» از سیاست دفتر.
 *
 * «روشن» یعنی گفته واقعاً به AI می‌رود: حالت فهم فعال، دامنهٔ «همه» و موتور تصمیم ۲.
 * روی دفتر آزمایشی سایت (۴ آبان ۱۴۰۵) موتور ۲ جدا خاموش شده بود و دامنه «همه» مانده بود؛
 * کلید سبز بود و می‌نوشت «هر گفته اول با AI فهمیده می‌شود»، ولی هیچ گفته‌ای به AI نمی‌رفت.
 * حالا آن حالت «خاموش» نشان داده می‌شود و زدن کلید (`setUnderstandingForAll(true)`)
 * موتور ۲ را هم روشن می‌کند.
 */
export function aiForAllState(understanding = {}, role = '') {
  const available = Boolean(understanding?.available);
  const engineV2 = Boolean(understanding?.engineV2);
  const on = understanding?.mode === 'active' && understanding?.scope === 'all' && engineV2;
  return {
    on, available, engineV2,
    ready: on && available,
    // دامنه «همه» است ولی موتور ۲ خاموش: کاربر باید بداند چرا AI اجرا نمی‌شود.
    halfOn: understanding?.mode === 'active' && understanding?.scope === 'all' && !engineV2,
    canManage: ['owner', 'manager'].includes(role),
  };
}
