import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4173',
        // P2 بازخورد UX: در حالت توسعه، وقتی مرورگر دامنه‌ای غیر از خود سرور
        // دارد (پیش‌نمایش خارجی یا تونل)، سرور بررسی originMatchesHost را
        // با 403 INVALID_ORIGIN جواب می‌داد. اینجا Host و Origin هر دو به
        // مقصد بازنویسی می‌شوند تا dev همیشه هم‌مبدأ است؛ در تولید پروکسی
        // وجود ندارد و امنیت سرور دست‌نخورده می‌ماند.
        changeOrigin: true,
        headers: { origin: 'http://localhost:4173' },
      },
    },
  },
  build: { sourcemap: true },
});
