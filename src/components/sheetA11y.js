import { useEffect, useRef } from 'react';

/**
 * دسترس‌پذیری یکدست برگه‌های مدالی — P1 بازخورد UX مالک محصول (۲۶ مهر ۱۴۰۵).
 *
 * پیش از این هر برگه رفتار خودش را داشت: Escape در بعضی برگه‌ها بود و در
 * بعضی نبود، فوکوس با Tab از برگه بیرون می‌پرید (تلهٔ فوکوس نبود) و بعد از
 * بستن، فوکوس به جای اولش برنمی‌گشت. این قلاب هر چهار رفتار را یکدست می‌کند:
 *
 *  ۱. Escape برگه را می‌بندد (اگر close بدهی).
 *  ۲. Tab و Shift+Tab درون برگه می‌چرخند (focus-trap).
 *  ۳. باز شدن، فوکوس را به نخستین کنترل برگه می‌برد.
 *  ۴. بستن، فوکوس را به عنصری که برگه را باز کرده برمی‌گرداند.
 *
 * برگه‌ها فقط وقتی سوارند که بازند، پس قلاب روی سوارشدن اجرا می‌شود.
 */
export function useSheetA11y(close) {
  const ref = useRef(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null || element === document.activeElement);
    const first = focusables()[0];
    if (first) first.focus();
    else if (node instanceof HTMLElement) node.focus();
    const onKey = (event) => {
      if (event.key === 'Escape' && closeRef.current) {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === firstItem || !node.contains(document.activeElement))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (document.activeElement === lastItem || !node.contains(document.activeElement))) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, []);
  return ref;
}
