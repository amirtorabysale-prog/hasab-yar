/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F4F6F8', surface: '#FFFFFF', ink: '#182B38', muted: '#526573',
        line: '#DFE6EB', income: '#1E5D46', expense: '#A8332A', accent: '#176E68',
        'warn-bg': '#FDF0E8',
      },
      fontFamily: { vazir: ['Vazirmatn', 'Tahoma', 'sans-serif'] },
      boxShadow: { paper: '0 2px 12px rgba(28, 27, 25, 0.055)' },
    },
  },
  plugins: [],
};
