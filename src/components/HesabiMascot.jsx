import { memo, useEffect, useId, useRef, useState } from 'react';
import { formatAmount } from '../lib/format.js';

/**
 * «حسابی» — نماد ماشین‌حساب حساب‌یار، نشسته روی نوار ضبط.
 *
 * صورتش LCD است و هر حالِ برنامه را با بدنِ خودش نشان می‌دهد: موجِ صدای واقعیِ
 * میکروفون وقتی می‌شنود؛ کلیدِ همان رقمی که کاربر می‌نویسد فشرده می‌شود و مبلغِ
 * نوشته‌شده («۱۵ میلیون» ← ۱۵٬۰۰۰٬۰۰۰) روی LCD می‌آید؛ هنگام پردازش رقم‌ها
 * می‌چرخند و موجی از کلیدها روی صفحه‌کلید می‌دود؛ سؤال، حبابِ «؟» بالای سرش
 * است؛ ثبت، نوار کاغذیِ چاپی؛ و هشدار، ماندهٔ منفیِ کهربایی و دست‌ها روی گونه‌ها.
 *
 * تزئینی است (`aria-hidden`): وضعیت را نشانِ متنیِ کنارش با aria-live اعلام می‌کند.
 * پلک‌زدنِ بیکاری چند بار تکرار می‌شود و می‌ایستد (WCAG 2.2.2)، با «کاهش حرکت»
 * هیچ حرکتی نیست و هر حال یک ژست ثابت دارد. نگاهی که ماوس را دنبال می‌کند با ref
 * و requestAnimationFrame مستقیم روی گروهِ صورت نوشته می‌شود، بی بازرندرِ React.
 */

const KEYS = [[2, 12], [6, 12], [10, 12], [14, 12], [2, 15], [6, 15], [10, 15], [14, 15], [2, 18], [6, 18], [10, 18], [14, 18], [2, 21], [6, 21], [10, 21], [14, 21]];
const KEY_KIND = { 3: ' hs-k-op', 7: ' hs-k-op', 11: ' hs-k-op', 15: ' hs-k-op', 14: ' hs-k-eq' };
const KEY_OF_DIGIT = { 7: 0, 8: 1, 9: 2, 4: 4, 5: 5, 6: 6, 1: 8, 2: 9, 3: 10, 0: 12 };
const RIPPLE = [0, 1, 4, 2, 5, 8, 3, 6, 9, 12, 7, 10, 13, 11, 14, 15];
const BARS = [4, 5.2, 6.4, 7.6, 8.8, 10, 11.2, 12.4, 13.6];
const SPARKS = [[-1.8, 3], [21.5, -1], [22, 9], [-2.2, 10]];
const POINTER_QUERY = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';

function latinDigit(char) {
  const persian = '۰۱۲۳۴۵۶۷۸۹'.indexOf(char);
  if (persian >= 0) return persian;
  const arabic = '٠١٢٣٤٥٦٧٨٩'.indexOf(char);
  if (arabic >= 0) return arabic;
  return /^[0-9]$/.test(char) ? Number(char) : null;
}

/** عددِ هشت‌رقمیِ شبه‌تصادفی و تکرارپذیر برای هر تیکِ محاسبه. */
function scrambled(tick) {
  let seed = (tick * 7919 + 104729) % 233280;
  let digits = '';
  for (let index = 0; index < 8; index += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const digit = Math.floor((seed / 233280) * 10);
    digits += index === 0 ? String(1 + (digit % 9)) : String(digit);
  }
  return Number(digits);
}

const clamp = (value) => Math.max(-1, Math.min(1, value));

export const HesabiMascot = memo(function HesabiMascot({ mood = 'idle', amount = null, typed = '', alert = '', levels = null }) {
  const patternId = `hs-lcd-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const faceRef = useRef(null);
  const [tick, setTick] = useState(0);
  const [pressed, setPressed] = useState(-1);

  // تیکِ «محاسبه» فقط تا وقتی که پردازش در جریان است.
  useEffect(() => {
    if (mood !== 'thinking') return undefined;
    setTick(0);
    const timer = window.setInterval(() => setTick((value) => value + 1), 90);
    return () => window.clearInterval(timer);
  }, [mood]);

  // هر نویسه‌ای که کاربر می‌نویسد یک کلید را فشار می‌دهد: رقم، کلیدِ خودش را.
  const lastChar = typed.slice(-1);
  const typedLength = typed.length;
  useEffect(() => {
    if (mood !== 'typing' || !typedLength) return undefined;
    const digit = latinDigit(lastChar);
    setPressed(digit === null ? typedLength % 16 : KEY_OF_DIGIT[digit]);
    const timer = window.setTimeout(() => setPressed(-1), 150);
    return () => window.clearTimeout(timer);
  }, [mood, typedLength, lastChar]);

  // نگاهِ بیکاری ماوس را دنبال می‌کند؛ فقط با ماوس واقعی و بی «کاهش حرکت».
  useEffect(() => {
    if (mood !== 'idle' || typeof window === 'undefined' || !window.matchMedia?.(POINTER_QUERY).matches) return undefined;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    const follow = () => {
      frame = 0;
      const face = faceRef.current;
      const svg = face?.ownerSVGElement;
      if (!svg) return;
      const box = svg.getBoundingClientRect();
      const dx = clamp((pointerX - (box.left + box.width / 2)) / 320);
      const dy = clamp((pointerY - (box.top + box.height * 0.36)) / 320);
      face.style.transform = `translate(${(dx * 0.9).toFixed(2)}px, ${(dy * 0.55).toFixed(2)}px)`;
    };
    const move = (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!frame) frame = window.requestAnimationFrame(follow);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      if (frame) window.cancelAnimationFrame(frame);
      if (faceRef.current) faceRef.current.style.transform = '';
    };
  }, [mood]);

  let lcd = '';
  let down = -1;
  let progress = 0;
  if (mood === 'typing') {
    lcd = amount ? formatAmount(amount) : '';
    down = pressed;
  }
  if (mood === 'thinking') {
    // رقم‌ها می‌چرخند و موجی از کلیدها می‌دود؛ اگر مبلغ معلوم است، آخرِ هر دور روی آن می‌نشیند.
    const step = tick % (amount ? 34 : 26);
    if (step < 26) {
      lcd = formatAmount(scrambled(tick));
      down = RIPPLE[step % 16];
      progress = Math.round(((step + 1) / 26) * 100) / 100;
    } else {
      lcd = formatAmount(amount);
      progress = 1;
    }
  }
  const liveLevels = mood === 'listening' && Array.isArray(levels) && levels.length ? levels : null;

  return (
    <span className={`hs is-${mood}${liveLevels ? ' hs-live' : ''}`} aria-hidden="true">
      <svg className="hs-svg" viewBox="-3 -11 26 39" focusable="false">
        <defs>
          <pattern id={patternId} width="1" height=".5" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="1" height=".16" fill="#000" fillOpacity=".22" /></pattern>
        </defs>
        <ellipse className="hs-shadow" cx="9.5" cy="27.4" rx="7.5" ry=".75" />
        <g className="hs-sparks">
          {SPARKS.map(([x, y]) => <g key={`${x}:${y}`}><rect className="hs-spark" x={x - 0.7} y={y - 0.2} width="1.4" height=".4" /><rect className="hs-spark" x={x - 0.2} y={y - 0.7} width=".4" height="1.4" /></g>)}
        </g>
        <g className="hs-bubble-g">
          <rect className="hs-bubble" x="13" y="-10.5" width="8" height="6" />
          <rect className="hs-bubble" x="12.5" y="-10" width="9" height="5" />
          <rect className="hs-bubble" x="13.4" y="-4.6" width="1.4" height="1" />
          <rect className="hs-bubble" x="12.8" y="-3.7" width="1" height=".9" />
          <text className="hs-q" x="17" y="-5.75" fontSize="4.6" textAnchor="middle">؟</text>
        </g>
        <g className="hs-fig"><g className="hs-core">
          <g className="hs-tape">
            <polygon className="hs-paper" points="7,1 7,-7.4 7.5,-8 8,-7.4 8.5,-8 9,-7.4 9.5,-8 10,-7.4 10.5,-8 11,-7.4 11.5,-8 12,-7.4 12,1" />
            <rect className="hs-ink" x="7.8" y="-6.6" width="3.4" height=".3" />
            <rect className="hs-ink" x="8.6" y="-5.8" width="2.6" height=".3" />
            <rect className="hs-ink" x="7.6" y="-3.3" width="3.8" height=".15" />
            <polyline className="hs-tick" points="8.6,-1.9 9.3,-1.2 10.6,-2.6" />
          </g>
          <rect className="hs-b" x="4" y="24.6" width="2" height="2.4" />
          <rect className="hs-b" x="13" y="24.6" width="2" height="2.4" />
          <rect className="hs-bd" x="4" y="26.4" width="2" height=".6" />
          <rect className="hs-bd" x="13" y="26.4" width="2" height=".6" />
          <g className="hs-arm hs-arm-l"><rect className="hs-b" x="-1.6" y="12" width="1.6" height="3.6" /><rect className="hs-bl" x="-1.6" y="14.6" width="1.6" height="1" /></g>
          <g className="hs-arm hs-arm-r"><rect className="hs-b" x="19" y="12" width="1.6" height="3.6" /><rect className="hs-bl" x="19" y="14.6" width="1.6" height="1" /></g>
          <rect className="hs-b" x="0" y="1" width="19" height="23" />
          <rect className="hs-b" x="1" y="0" width="17" height="25" />
          <rect className="hs-bl" x="1" y="0" width="16" height="1" />
          <rect className="hs-bl" x="0" y="1" width="1" height="22" />
          <rect className="hs-bd" x="2" y="24" width="16" height="1" />
          <rect className="hs-bd" x="18" y="2" width="1" height="22" />
          <rect className="hs-slot" x="7" y="0" width="5" height=".6" />
          <g>{[11.5, 12.8, 14.1, 15.4].map((x) => <rect key={x} className="hs-cell" x={x} y=".9" width="1.2" height="1.4" />)}</g>
          <rect className="hs-bezel" x="2" y="3" width="15" height="7.2" />
          <rect className="hs-lcd" x="2.6" y="3.6" width="13.8" height="6" />
          <rect x="2.6" y="3.6" width="13.8" height="6" fill={`url(#${patternId})`} />
          <g className="hs-face" ref={faceRef}>
            <g className="hs-eyes" key={mood}><rect className="hs-fg" x="6.4" y="5.2" width="1.5" height="2.6" rx=".35" /><rect className="hs-fg" x="11.1" y="5.2" width="1.5" height="2.6" rx=".35" /></g>
          </g>
          <g className="hs-happy"><polyline className="hs-fg-line" points="6.2,7.4 7.15,5.9 8.1,7.4" /><polyline className="hs-fg-line" points="10.9,7.4 11.85,5.9 12.8,7.4" /></g>
          <g className="hs-worry"><rect className="hs-fg" x="6.6" y="6.1" width="1.2" height="1.6" rx=".3" /><rect className="hs-fg" x="11.2" y="6.1" width="1.2" height="1.6" rx=".3" /><polyline className="hs-fg-line" points="5.9,5.5 8,4.8" /><polyline className="hs-fg-line" points="11,4.8 13.1,5.5" /></g>
          <g className="hs-curious"><rect className="hs-fg" x="6.4" y="5.4" width="1.5" height="2.4" rx=".35" /><rect className="hs-fg" x="11" y="4.9" width="1.8" height="3.1" rx=".4" /><polyline className="hs-fg-line" points="10.7,4.25 13,3.95" /></g>
          <g className="hs-wave">
            {BARS.map((x, index) => <rect key={x} className="hs-fg hs-bar" x={x} y="5.1" width=".6" height="3"
              style={liveLevels ? { transform: `scaleY(${Math.max(0.2, Math.min(1, Number(liveLevels[index % liveLevels.length]) / 44)).toFixed(2)})` } : undefined} />)}
          </g>
          <g className="hs-progress-g"><rect className="hs-track" x="3.4" y="8.7" width="12.2" height=".35" /><rect className="hs-fg hs-progress" x="3.4" y="8.7" width="12.2" height=".35" style={{ transform: `scaleX(${progress})` }} /></g>
          <text className="hs-fg hs-num" x="15.9" y="7.55" fontSize="2.3" textAnchor="end" direction="ltr">{lcd}</text>
          <text className="hs-warn hs-neg" x="15.9" y="7.4" fontSize="2.05" textAnchor="end" direction="ltr">{alert || '−'}</text>
          <circle className="hs-warn hs-rec" cx="15.5" cy="4.45" r=".38" />
          <rect className="hs-fg hs-cursor" x="8.9" y="8.65" width="1.2" height=".35" />
          <polygon className="hs-glass" points="10.6,3.6 11.6,3.6 9.8,9.6 8.8,9.6" />
          <polygon className="hs-glass" points="12.1,3.6 12.5,3.6 10.7,9.6 10.3,9.6" />
          {KEYS.map(([x, y], index) => (
            <g key={index} className={`hs-k${KEY_KIND[index] || ''}${index === down ? ' is-down' : ''}`}>
              <rect className="hs-k-side" x={x} y={y + 0.5} width="3" height="1.5" />
              <g className="hs-k-cap"><rect className="hs-k-top" x={x} y={y} width="3" height="1.5" /></g>
            </g>
          ))}
          <g className="hs-sweat"><rect className="hs-drop" x="20.6" y="4.1" width=".5" height=".5" /><rect className="hs-drop" x="20.4" y="4.6" width=".9" height="1.3" /></g>
        </g></g>
      </svg>
    </span>
  );
});
