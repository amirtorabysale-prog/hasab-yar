import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { THEMES, THEME_LABELS, setTheme, storedTheme } from '../lib/theme.js';

const ICONS = { light: Sun, dark: Moon, system: Monitor };

/** کلید تم در نوار بالا: روشن ← تاریک ← خودکار. برچسبش می‌گوید الان کدام است و بعدی چیست. */
export function ThemeToggle({ className = '' }) {
  const [choice, setChoice] = useState(() => storedTheme());
  const next = THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length];
  const Icon = ICONS[choice];
  return <button type="button" onClick={() => setChoice(setTheme(next))}
    aria-label={`تم: ${THEME_LABELS[choice]}؛ برای ${THEME_LABELS[next]} بزن`} title={`تم: ${THEME_LABELS[choice]}`}
    className={`tap grid place-items-center rounded-lg border border-line text-muted hover:bg-paper hover:text-ink ${className}`}>
    <Icon size={18} aria-hidden="true" />
  </button>;
}

/** انتخاب تم در تنظیمات: سه گزینهٔ روشن. */
export function ThemeChoice() {
  const [choice, setChoice] = useState(() => storedTheme());
  return <div role="radiogroup" aria-label="تم برنامه" className="inline-flex rounded-xl border border-line bg-surface p-1">
    {THEMES.map((mode) => {
      const Icon = ICONS[mode];
      const active = mode === choice;
      return <button key={mode} type="button" role="radio" aria-checked={active} onClick={() => setChoice(setTheme(mode))}
        className={`flex min-h-[40px] items-center gap-2 rounded-lg px-4 text-sm font-bold ${active ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink'}`}>
        <Icon size={16} aria-hidden="true" />{THEME_LABELS[mode]}
      </button>;
    })}
  </div>;
}
