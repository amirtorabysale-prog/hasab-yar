import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import './styles.css';
import { applyTheme, watchSystemTheme } from './lib/theme.js';

// تم پیش از اولین رنگ‌آمیزی React اعمال می‌شود تا صفحه یک لحظه روشن و بعد تاریک نشود.
applyTheme();
watchSystemTheme();

// برگهٔ سبک فونت بعد از شروع برنامه اضافه می‌شود، نه در مسیر اولین رنگ‌آمیزی.
// یک `<link rel="stylesheet">` که از ابتدا در HTML باشد، تا رسیدن یا
// timeout شدنش صفحه را سفید نگه می‌دارد؛ همین گره وقتی با JavaScript ساخته
// شود فقط فونت را عوض می‌کند و هیچ‌وقت جلوی نمایش برنامه را نمی‌گیرد.
// `preload` در `index.html` باعث می‌شود همین‌جا از حافظه برداشته شود.
const vazirmatn = document.createElement('link');
vazirmatn.rel = 'stylesheet';
vazirmatn.href = 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap';
document.head.appendChild(vazirmatn);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>,
);

// صفحهٔ آغاز را CSS همان لحظه‌ای که `#root` پر می‌شود پنهان می‌کند؛ این خط فقط
// گرهٔ مرده را از DOM بیرون می‌برد تا صفحه‌خوان‌ها «در حال بارگذاری» را روی
// برنامهٔ بالاآمده نخوانند.
document.getElementById('boot')?.remove();
