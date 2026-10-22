// صفحه و بخشِ باز، و رفتن میان آن‌ها: نشانی مرورگر، دکمهٔ «بازگشت»، مرز صفحه‌های
// مجاز هر نقش، کشوی منو و میان‌بُر Ctrl+K.
//
// از src/App.jsx جدا شد؛ متن توابع و effectها دست نخورده است. App این قلاب را در
// هر رندر با مقدارهای همان رندر صدا می‌زند، پس هر closure همان چیزی را می‌بیند که
// پیش‌تر درون App می‌دید.

import { useEffect, useRef, useState } from 'react';
import { allowedScreens } from './navigation.jsx';
import { readRoute, writeRoute } from './route.js';

export function useScreenNavigation(access) {
  // صفحه و بخش از نشانی خوانده می‌شوند (`src/app/route.js`)؛ تازه‌سازی همان صفحه را باز می‌کند.
  const [screen, setScreen] = useState(() => readRoute().screen || 'today');
  // بخش داخل صفحه: زبانهٔ دفتر مالی، حسابداری، کدینگ، همکاری یا تنظیمات.
  const [section, setSection] = useState(() => readRoute().section);
  const menuSearchRef = useRef(null);
  const [drawer, setDrawer] = useState(false);

  // Ctrl+K: جست‌وجوی منو، مثل نوار جست‌وجوی نرم‌افزارهای حسابداری.
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (window.matchMedia('(min-width: 1024px)').matches && menuSearchRef.current) menuSearchRef.current.focus();
      else setDrawer(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigate = (target, section = '', { fromHistory = false } = {}) => {
    // صفحه‌ای که این کاربر اجازه‌اش را ندارد حتی با ناوبری مستقیم باز نمی‌شود.
    // سرور هم همین مرز را دارد، پس این فقط تجربه را تمیز نگه می‌دارد — ولی
    // نبودش یعنی کاربر ساده می‌تواند به صفحه‌ای برود که همهٔ درخواست‌هایش ۴۰۳
    // می‌گیرند و فقط خطا می‌بیند.
    if (allowedScreens(access).length && !allowedScreens(access).some((item) => item.id === target)) return;
    // یادگیری‌ها زبانهٔ تنظیمات شد؛ پیوندهای قدیمی همان‌جا می‌روند.
    if (target === 'learning') { target = 'settings'; section = 'learning'; }
    if (!fromHistory) writeRoute(target, section);
    setSection(section);
    setScreen(target); setDrawer(false);
    // صفحه‌ها تنبل بارگذاری می‌شوند؛ بخش مقصد چند لحظه بعد ساخته می‌شود.
    if (section) {
      let tries = 0;
      const seek = () => {
        const target = document.getElementById(section);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if ((tries += 1) < 20) window.setTimeout(seek, 100);
      };
      window.setTimeout(seek, 40);
    }
    // صفحهٔ تازه از بالا باز می‌شود، فوری. اسکرول نرم پیش از عوض‌شدن محتوا شروع
    // می‌شد و جابه‌جایی صفحه آن را نیمه‌راه قطع می‌کرد؛ کاربر از پایین تنظیمات
    // مستقیم به پایین «همکاری حسابدار» می‌رسید و بخش اصلی را نمی‌دید.
    if (!section) window.scrollTo({ top: 0, behavior: 'auto' });
  };

  // «بازگشت» و «جلو» مرورگر همان صفحهٔ نشانی را باز می‌کنند.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const onPop = () => { const route = readRoute(); navigateRef.current(route.screen || 'today', route.section, { fromHistory: true }); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // نشانیِ صفحه‌ای که این کاربر اجازه‌اش را ندارد (یا پیوند کهنه) به «امروز» برمی‌گردد.
  useEffect(() => {
    const screens = allowedScreens(access);
    if (!screens.length) return;
    if (!screens.some((item) => item.id === screen)) { writeRoute('today', '', { replace: true }); setScreen('today'); setSection(''); return; }
    writeRoute(screen, section, { replace: true });
  }, [access, screen, section]);
  return { screen, section, setSection, drawer, setDrawer, menuSearchRef, navigate };
}
