/**
 * نماد DNA — مارپیچ دوگانه، از تختهٔ طراحی مالک محصول (۲۹ مهر ۱۴۰۵، «نماد DNA — متحرک»).
 *
 * پله‌ها در محور افقی جمع و باز می‌شوند (scaleX) و لایهٔ جلوی هر پله هنگام عبور از محور محو
 * می‌شود تا عمق حس شود؛ فقط transform و opacity، بی‌جاوااسکریپت. دو اندازه:
 * - `menu`: چهار پله با خط ضخیم، برای منو — ساکن، و فقط با hover می‌چرخد؛
 * - `hero`: هفت پله با میلهٔ دوتکه، گرهٔ کناری و محور نقطه‌چین، برای سرصفحهٔ DNA — هنگام باز شدن
 *   صفحه سه دور می‌چرخد و می‌ایستد (WCAG 2.2.2).
 * رنگ از توکن‌های سایت (`--c-accent`) است، پس حالت تاریک خودبه‌خود درست است.
 */
const MENU_RUNGS = [12.3, 23.3, 36.3, 47.3];
const HERO_RUNGS = [7.8, 14.8, 21.8, 29.8, 36.8, 43.8, 50.8];

export function DnaHelix({ variant = 'menu', size = 18, className = '', label = '' }) {
  if (variant === 'hero') {
    return <svg className={`dna-helix dna-hero ${className}`.trim()} width={Math.round(size * 40 / 64)} height={size} viewBox="0 0 40 64" fill="none" style={{ '--step': '-0.4s' }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}>
      <line className="dna-axis" x1="20" y1="5" x2="20" y2="59" />
      <path className="dna-strand dna-back" strokeWidth="2.2" d="M20 3C6 11 6 23 20 31C34 39 34 51 20 59" />
      <path className="dna-strand dna-front" strokeWidth="2.8" d="M20 3C34 11 34 23 20 31C6 39 6 51 20 59" />
      {HERO_RUNGS.map((y, index) => <g key={y} className="dna-rung" style={{ '--i': index }}>
        <g className="dna-bar-back"><rect x="9.2" y={y} width="9.4" height="2.4" rx="1.2" /><rect x="21.4" y={y} width="9.4" height="2.4" rx="1.2" /></g>
        <g className="dna-bar-front"><rect x="9.2" y={y} width="9.4" height="2.4" rx="1.2" /><rect x="21.4" y={y} width="9.4" height="2.4" rx="1.2" />
          <circle className="dna-knob" cx="9.6" cy={y + 1.2} r="1.7" /><circle className="dna-knob" cx="30.4" cy={y + 1.2} r="1.7" /></g>
      </g>)}
    </svg>;
  }
  return <svg className={`dna-helix dna-menu ${className}`.trim()} width={Math.round(size * 40 / 64)} height={size} viewBox="0 0 40 64" fill="none" style={{ '--step': '-0.8s' }} aria-hidden="true">
    <path className="dna-strand dna-back" strokeWidth="3.4" d="M20 4C7 12 7 22 20 31C33 40 33 52 20 60" />
    <path className="dna-strand dna-front" strokeWidth="3.4" d="M20 4C33 12 33 22 20 31C7 40 7 52 20 60" />
    {MENU_RUNGS.map((y, index) => <g key={y} className="dna-rung" style={{ '--i': index }}>
      <rect className="dna-bar-back" x="10.6" y={y} width="18.8" height="3.4" rx="1.7" />
      <rect className="dna-bar-front" x="10.6" y={y} width="18.8" height="3.4" rx="1.7" />
    </g>)}
  </svg>;
}

/** همان امضای آیکن‌های lucide (`size`، `aria-hidden`) تا منو و نوار پایین بی‌تفاوت با آن رفتار کنند. */
export function DnaIcon({ size = 18, className = '' }) {
  return <DnaHelix variant="menu" size={Math.round(size * 1.25)} className={className} />;
}
