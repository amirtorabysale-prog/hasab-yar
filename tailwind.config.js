/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F5F3ED', surface: '#FFFFFF', ink: '#1C1B19', muted: '#6E6C64',
        line: '#DDDAD1', income: '#1E5D46', expense: '#A8332A', accent: '#C8622D',
        'warn-bg': '#FDF0E8',
      },
      fontFamily: { vazir: ['Vazirmatn', 'Tahoma', 'sans-serif'] },
      boxShadow: { paper: '0 2px 12px rgba(28, 27, 25, 0.055)' },
    },
  },
  plugins: [],
};
