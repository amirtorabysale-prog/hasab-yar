import { useMemo, useRef } from 'react';

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
 * برگه‌های روی هم: برگهٔ تأیید منفی‌شدن یا «شاید تکراری» روی برگهٔ «فهم گفته» باز
 * می‌شود. هر برگه شنوندهٔ خودش را روی window دارد؛ اگر همه کلید را می‌گرفتند،
 * برگهٔ زیرین فوکوس را از برگهٔ رویی می‌دزدید (Tab روی دکمهٔ اول گیر می‌کرد) و
 * Escape هر دو را می‌بست. پس فقط بالاترین برگهٔ باز کلید را می‌گیرد.
 *
 * قلاب یک ref callback برمی‌گرداند، نه useRef با useEffect([]): برگه‌ای که داخل
 * یک صفحهٔ همیشه‌سوار فقط گاهی رندر می‌شود (ویرایش و پرداخت دفتر مالی، تنخواه)
 * در لحظهٔ سوار شدن صفحه هنوز در DOM نبود و هرگز وصل نمی‌شد.
 */

const openSheets = [];

export function openSheetCount() { return openSheets.length; }

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** برگه را وصل می‌کند و تابع جداکردنش را برمی‌گرداند؛ `env` فقط برای آزمون است. */
export function attachSheet(node, getClose, { doc = document, win = window } = {}) {
  const token = {};
  openSheets.push(token);
  const isTop = () => openSheets[openSheets.length - 1] === token;
  const opener = doc.activeElement instanceof win.HTMLElement ? doc.activeElement : null;
  const focusables = () => [...node.querySelectorAll(FOCUSABLE)]
    .filter((element) => element.offsetParent !== null || element === doc.activeElement);
  const first = focusables()[0];
  if (first) first.focus();
  else if (node instanceof win.HTMLElement) node.focus();
  const onKey = (event) => {
    if (!isTop()) return;
    const close = getClose();
    if (event.key === 'Escape' && close) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    if (event.shiftKey && (doc.activeElement === firstItem || !node.contains(doc.activeElement))) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && (doc.activeElement === lastItem || !node.contains(doc.activeElement))) {
      event.preventDefault();
      firstItem.focus();
    }
  };
  win.addEventListener('keydown', onKey, true);
  return () => {
    win.removeEventListener('keydown', onKey, true);
    // برگهٔ زیرینی که زودتر بسته شود، فوکوس را از برگهٔ رویی نمی‌دزدد.
    const wasTop = isTop();
    const index = openSheets.indexOf(token);
    if (index >= 0) openSheets.splice(index, 1);
    if (wasTop) opener?.focus?.();
  };
}

/** ref callback برگه: با رسیدن گره وصل می‌شود و با رفتنش جدا. */
export function sheetRefCallback(getClose, env) {
  let detach = null;
  return (node) => {
    detach?.();
    detach = node ? attachSheet(node, getClose, env) : null;
  };
}

export function useSheetA11y(close) {
  const closeRef = useRef(close);
  closeRef.current = close;
  return useMemo(() => sheetRefCallback(() => closeRef.current), []);
}
