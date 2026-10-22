import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { freeNames } from './helpers/freeNames.js';

/**
 * هیچ فایلی نامی را نمی‌خواند که تعریف یا import نکرده باشد.
 *
 * دو نمونهٔ واقعی این آزمون را لازم کرد. هر دو از ساخت و از همهٔ آزمون‌های دیگر
 * رد شده بودند:
 * - نه مسیر `/api/tax-knowledge` توابع دفتر را صدا می‌زدند بی‌آنکه import کرده
 *   باشند؛ هر درخواست ۵۰۰ می‌گرفت.
 * - برگهٔ نیت دکمه‌ای داشت که `queueReview` را می‌خواند، ولی این prop فقط به
 *   برگهٔ تسویه داده می‌شد؛ رسیدن به آن خط صفحه را می‌انداخت.
 *
 * با شکستن فایل‌های بزرگ به چند فایل، همین خطا محتمل‌ترین خطاست: تابعی جابه‌جا
 * می‌شود و importش جا می‌ماند.
 */

const ROOT = join(import.meta.dirname, '..');
const DIRECTORIES = ['server', 'shared', 'src', 'scripts', 'public'];

const BROWSER_AND_WORKER = `window document navigator localStorage sessionStorage location history fetch FormData Blob File
FileReader URL URLSearchParams AbortController AudioContext AudioWorkletNode MediaRecorder requestAnimationFrame
cancelAnimationFrame crypto indexedDB IDBKeyRange matchMedia getComputedStyle self caches clients Response Request Headers
TextEncoder TextDecoder performance alert confirm Notification ResizeObserver IntersectionObserver MutationObserver
HTMLElement Element Event CustomEvent KeyboardEvent DOMParser XMLSerializer Image Audio speechSynthesis SpeechRecognition
webkitSpeechRecognition RTCPeerConnection MediaStream screen print open close scrollTo innerWidth innerHeight
devicePixelRatio importScripts registration skipWaiting WebSocket EventSource Worker OfflineAudioContext AnalyserNode
ImageData OffscreenCanvas createImageBitmap DOMException ReadableStream WritableStream TransformStream CompressionStream
DecompressionStream PerformanceObserver visualViewport scrollX scrollY Option Path2D CanvasRenderingContext2D
process Buffer console setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone undefined arguments`;
const GLOBALS = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER_AND_WORKER.split(/\s+/)]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(js|jsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test('سنجهٔ نام آزاد: import جاافتاده، prop نرسیده و کامپوننت تعریف‌نشده را می‌گیرد', () => {
  const free = freeNames('probe.jsx', `
    import { used } from './a.js';
    export function Sheet({ draft, close }) {
      const { amount = fallback } = draft;
      try { used(amount); } catch (error) { close(error); }
      for (const item of draft.items) used(item);
      return <Missing.Panel onClick={() => queueReview(draft)}><div>{amount}</div><Known /></Missing.Panel>;
    }
    function Known() { return null; }
  `);
  assert.deepEqual([...free].sort(), ['Missing', 'fallback', 'queueReview']);
});

test('هیچ فایل برنامه نام تعریف‌نشده نمی‌خواند', () => {
  const problems = DIRECTORIES.flatMap((directory) => sourceFiles(join(ROOT, directory)))
    .flatMap((file) => [...freeNames(file)].filter((name) => !GLOBALS.has(name)).map((name) => `${relative(ROOT, file)}: ${name}`));
  assert.deepEqual(problems, []);
});
