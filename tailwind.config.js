/** @type {import('tailwindcss').Config} */
// رنگ‌ها از متغیرهای CSS خوانده می‌شوند (`src/styles.css`)؛ کلاس `dark` روی `<html>` همهٔ
// صفحه‌ها را یکجا عوض می‌کند. `on-fill` متنِ روی رنگ پر (دکمهٔ اصلی، برچسب پررنگ) است:
// در روشن سفید و در تاریک تیره، تا روی رنگ روشن‌ترِ حالت تاریک هم خوانا بماند.
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        paper: token('paper'), surface: token('surface'), ink: token('ink'), muted: token('muted'),
        line: token('line'), income: token('income'), expense: token('expense'), accent: token('accent'),
        'warn-bg': token('warn-bg'), warn: token('warn'), 'on-fill': token('on-fill'), scrim: token('scrim'),
      },
      fontFamily: { vazir: ['Vazirmatn', 'Tahoma', 'sans-serif'] },
      boxShadow: {
        paper: '0 1px 2px rgb(var(--c-shadow) / 0.06), 0 2px 10px rgb(var(--c-shadow) / 0.05)',
        raised: '0 4px 24px rgb(var(--c-shadow) / 0.10)',
      },
    },
  },
  plugins: [],
};
