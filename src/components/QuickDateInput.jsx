// انتخاب‌گر سریع تاریخ شمسی — یک فیلد برای همهٔ برنامه.
//
// سه راه، هر کدام یک حرکت:
//  ۱) بنویس: «۲۵»، «۲۵ ۲»، «۲/۲۵»، «دیروز»، «-۳»، «+۱۰»؛ تفسیر همان لحظه زیرش
//     دیده می‌شود و Enter ثبتش می‌کند.
//  ۲) میان‌بر: امروز، دیروز، اول ماه، آخر ماه… به جهت همان فیلد.
//  ۳) تقویم: یک ماه، با فلش‌های صفحه‌کلید (چپ = روز بعد، چون تقویم راست‌به‌چپ است).
// روی خود فیلد بسته هم ↑/↓ یک روز و PageUp/PageDown یک ماه جابه‌جا می‌کند؛ زدن یک
// رقم همان‌جا باز می‌کند و رقم را در کادر می‌گذارد.
//
// قالب مقدار بیرونی با `format` تعیین می‌شود: 'iso' (پیش‌فرض)، 'date' (YYYY-MM-DD
// میلادیِ روز تهران، جای <input type="date">) یا 'jalali' («1405/08/07»).

import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  MONTH_NAMES, WEEKDAY_INITIALS, addDays, addMonths, compareDays, isoToValue, jalaliOf, jalaliText, jalaliToISO,
  monthGrid, parseQuickDate, quickPresets, relativeLabel, sameDay, valueToISO,
} from '../../shared/quickDate.js';

const fa = (value) => String(value).replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);

function useOutside(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (event) => { if (ref.current && !ref.current.contains(event.target)) close(); };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open, close, ref]);
}

export function QuickDateInput({
  value, onChange, format = 'iso', direction = 'any', min, max, placeholder = 'انتخاب تاریخ',
  required = false, disabled = false, className = '', 'aria-label': ariaLabel, id,
}) {
  const iso = valueToISO(value, format);
  const selected = jalaliOf(iso);
  const today = jalaliOf(new Date().toISOString());
  const minParts = jalaliOf(valueToISO(min, format));
  const maxParts = jalaliOf(valueToISO(max, format));
  const allowed = (parts) => (!minParts || compareDays(parts, minParts) >= 0) && (!maxParts || compareDays(parts, maxParts) <= 0);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [view, setView] = useState('days');
  const [cursor, setCursor] = useState(() => selected || today);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);
  const baseId = useId();
  const listId = `${baseId}-grid`;

  const close = (focus = false) => { setOpen(false); setText(''); setView('days'); if (focus) triggerRef.current?.focus(); };
  useOutside(rootRef, open, () => close());
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const parsed = useMemo(() => (text.trim() ? parseQuickDate(text, { direction }) : null), [text, direction]);
  // تفسیرِ در حال تایپ، تقویم را هم همان‌جا می‌برد تا کاربر ببیند کجا افتاده.
  useEffect(() => { if (parsed) setCursor(jalaliOf(parsed.iso)); }, [parsed]);

  const commit = (nextIso) => {
    if (!nextIso) return;
    const parts = jalaliOf(nextIso);
    if (!allowed(parts)) return;
    onChange(isoToValue(jalaliToISO(parts), format));
    close(true);
  };
  const shift = (base, days, months = 0) => {
    const start = base || today;
    const moved = months ? addMonths(start, months) : jalaliOf(addDays(jalaliToISO(start), days));
    return moved;
  };
  const openWith = (seed = '') => { if (disabled) return; setCursor(selected || today); setText(seed); setOpen(true); };

  const onTriggerKey = (event) => {
    if (disabled) return;
    const step = { ArrowUp: [1, 0], ArrowDown: [-1, 0], PageUp: [0, 1], PageDown: [0, -1] }[event.key];
    if (step) {
      event.preventDefault();
      const next = shift(selected, step[0], step[1]);
      if (allowed(next)) onChange(isoToValue(jalaliToISO(next), format));
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !required && iso) { event.preventDefault(); onChange(''); return; }
    if (event.key.length === 1 && /[\d۰-۹+\-آ-ی]/.test(event.key)) { event.preventDefault(); openWith(event.key); }
  };

  const onInputKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Enter') { event.preventDefault(); commit(parsed ? parsed.iso : jalaliToISO(cursor)); return; }
    if (text.trim()) return;
    // کادر خالی: فلش‌ها روی تقویم حرکت می‌کنند. تقویم راست‌به‌چپ است، پس چپ = روز بعد.
    const moves = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowDown: [7, 0], ArrowUp: [-7, 0], PageDown: [0, 1], PageUp: [0, -1] };
    const move = moves[event.key];
    if (move) { event.preventDefault(); setCursor(shift(cursor, move[0], move[1])); }
  };

  const relative = iso ? fa(relativeLabel(iso)) : '';
  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor.year, cursor.month]);
  const presets = useMemo(() => quickPresets(direction).filter((preset) => allowed(jalaliOf(preset.iso))), [direction, min, max]);
  const activeId = `${baseId}-${cursor.year}-${cursor.month}-${cursor.day}`;

  return <div ref={rootRef} className={`relative ${className}`}>
    <button
      ref={triggerRef} id={id} type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => (open ? close() : openWith())} onKeyDown={onTriggerKey}
      className="tap flex w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-right text-ink hover:bg-paper disabled:opacity-60"
    >
      <CalendarDays size={17} className="shrink-0 text-muted" aria-hidden="true" />
      {selected
        ? <span className="min-w-0 flex-1 truncate"><span className="font-bold">{jalaliText(selected)}</span>{relative && <span className="text-xs text-muted"> · {relative}</span>}</span>
        : <span className="min-w-0 flex-1 truncate text-muted">{placeholder}</span>}
    </button>

    {/* فیلد معمولاً داخل <label> است؛ کلیک روی فضای خالی پنجره نباید دوباره دکمهٔ فیلد را بزند و ببندد. */}
    {open && <div role="dialog" aria-label={ariaLabel || 'انتخاب تاریخ'} onClick={(event) => event.preventDefault()} className="date-pop absolute right-0 top-full z-[80] mt-1 w-[min(320px,calc(100vw-32px))] rounded-xl border border-line bg-paper p-3 text-ink shadow-paper">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onInputKey}
          placeholder="۲۵ · ۲۵ ۲ · دیروز · -۳" aria-label="تاریخ را بنویس" aria-controls={listId}
          aria-activedescendant={view === 'days' && !text.trim() ? activeId : undefined}
          className="tap min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
        />
        <button type="button" onClick={() => close(true)} aria-label="بستن" className="tap grid w-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface"><X size={18} /></button>
      </div>
      <p aria-live="polite" className={`mt-1.5 min-h-5 text-xs ${parsed ? 'font-bold text-accent' : 'text-muted'}`}>
        {parsed ? `${jalaliText(parsed)}${relativeLabel(parsed.iso) ? ` · ${fa(relativeLabel(parsed.iso))}` : ''}${allowed(parsed) ? ' — Enter' : ' — خارج از بازهٔ مجاز'}`
          : text.trim() ? 'خوانده نشد؛ مثلاً «۲۵»، «۲۵ اردیبهشت» یا «۳ روز پیش»' : 'بنویس، یا از میان‌بر و تقویم بزن'}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {presets.map((preset) => <button key={preset.label} type="button" onClick={() => commit(preset.iso)}
          className={`min-h-9 rounded-full border px-3 text-xs font-bold ${sameDay(jalaliOf(preset.iso), selected) ? 'border-accent bg-accent text-on-fill' : 'border-line hover:bg-surface'}`}>{preset.label}</button>)}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <button type="button" aria-label={view === 'days' ? 'ماه قبل' : 'سال قبل'} onClick={() => setCursor(view === 'days' ? addMonths(cursor, -1) : addMonths(cursor, -12))} className="tap grid w-11 place-items-center rounded-lg hover:bg-surface"><ChevronRight size={18} /></button>
        <button type="button" onClick={() => setView(view === 'days' ? 'months' : 'days')} aria-label="انتخاب ماه و سال" className="tap rounded-lg px-3 text-sm font-extrabold hover:bg-surface">
          {view === 'days' ? `${MONTH_NAMES[cursor.month - 1]} ${fa(cursor.year)}` : fa(cursor.year)}
        </button>
        <button type="button" aria-label={view === 'days' ? 'ماه بعد' : 'سال بعد'} onClick={() => setCursor(view === 'days' ? addMonths(cursor, 1) : addMonths(cursor, 12))} className="tap grid w-11 place-items-center rounded-lg hover:bg-surface"><ChevronLeft size={18} /></button>
      </div>

      {view === 'months'
        ? <div className="mt-1 grid grid-cols-3 gap-1">{MONTH_NAMES.map((name, index) => <button key={name} type="button"
            onClick={() => { setCursor({ year: cursor.year, month: index + 1, day: Math.min(cursor.day, 29) }); setView('days'); }}
            className={`min-h-10 rounded-lg text-sm ${cursor.month === index + 1 ? 'bg-accent font-bold text-on-fill' : 'hover:bg-surface'}`}>{name}</button>)}</div>
        : <div id={listId} role="grid" aria-label={`${MONTH_NAMES[cursor.month - 1]} ${fa(cursor.year)}`} className="mt-1">
          <div role="row" className="grid grid-cols-7 text-center text-[11px] text-muted">{WEEKDAY_INITIALS.map((day) => <span key={day} role="columnheader" className="py-1">{day}</span>)}</div>
          {Array.from({ length: grid.length / 7 }, (_, week) => <div key={week} role="row" className="grid grid-cols-7">
            {grid.slice(week * 7, week * 7 + 7).map((cell) => {
              const isSelected = sameDay(cell, selected);
              const isToday = sameDay(cell, today);
              const isCursor = sameDay(cell, cursor);
              const ok = allowed(cell);
              return <button key={cell.iso} id={`${baseId}-${cell.year}-${cell.month}-${cell.day}`} role="gridcell" type="button" tabIndex={-1}
                disabled={!ok} aria-selected={isSelected} aria-label={jalaliText(cell)} onClick={() => commit(cell.iso)}
                className={`numbers m-0.5 h-10 rounded-lg text-sm disabled:opacity-30
                  ${isSelected ? 'bg-accent font-bold text-on-fill' : cell.outside ? 'text-muted/60 hover:bg-surface' : 'hover:bg-surface'}
                  ${isToday && !isSelected ? 'font-bold text-accent ring-1 ring-inset ring-accent/50' : ''}
                  ${isCursor && !isSelected ? 'bg-surface' : ''}`}>{fa(cell.day)}</button>;
            })}
          </div>)}
        </div>}

      {!required && iso && <button type="button" onClick={() => { onChange(''); close(true); }} className="mt-2 min-h-9 text-xs font-bold text-muted hover:text-expense">پاک کردن تاریخ</button>}
    </div>}
  </div>;
}

/**
 * ماه شمسی (لیست حقوق و هر دورهٔ ماهانه). مقدار «۱۴۰۴/۰۶» است، همان شکلی که
 * پیش‌تر تایپ می‌شد، تا دوره‌های قبلی با تازه‌ها یکی بمانند.
 */
export function QuickMonthInput({ value, onChange, disabled = false, placeholder = 'انتخاب ماه', className = '', 'aria-label': ariaLabel }) {
  const latin = String(value || '').replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const match = /^(\d{4})\s*[/\-.]\s*(\d{1,2})$/.exec(latin.trim());
  const selected = match ? { year: Number(match[1]), month: Number(match[2]) } : null;
  const today = jalaliOf(new Date().toISOString());
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState((selected || today).year);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  useOutside(rootRef, open, () => setOpen(false));
  const pick = (parts) => { onChange(fa(`${parts.year}/${String(parts.month).padStart(2, '0')}`)); setOpen(false); triggerRef.current?.focus(); };
  const previous = addMonths({ ...today, day: 1 }, -1);
  return <div ref={rootRef} className={`relative ${className}`}>
    <button ref={triggerRef} type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setYear((selected || today).year); setOpen(!open); }}
      onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
      className="tap flex w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-right text-ink hover:bg-paper disabled:opacity-60">
      <CalendarDays size={17} className="shrink-0 text-muted" aria-hidden="true" />
      <span className={`min-w-0 flex-1 truncate ${selected ? 'font-bold' : 'text-muted'}`}>{selected ? `${MONTH_NAMES[selected.month - 1]} ${fa(selected.year)}` : placeholder}</span>
    </button>
    {open && <div role="dialog" aria-label={ariaLabel || 'انتخاب ماه'} onClick={(event) => event.preventDefault()} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } }}
      className="date-pop absolute right-0 top-full z-[80] mt-1 w-[min(300px,calc(100vw-32px))] rounded-xl border border-line bg-paper p-3 text-ink shadow-paper">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => pick(today)} className="min-h-9 rounded-full border border-line px-3 text-xs font-bold hover:bg-surface">این ماه</button>
        <button type="button" onClick={() => pick(previous)} className="min-h-9 rounded-full border border-line px-3 text-xs font-bold hover:bg-surface">ماه قبل</button>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button type="button" aria-label="سال قبل" onClick={() => setYear(year - 1)} className="tap grid w-11 place-items-center rounded-lg hover:bg-surface"><ChevronRight size={18} /></button>
        <span className="text-sm font-extrabold">{fa(year)}</span>
        <button type="button" aria-label="سال بعد" onClick={() => setYear(year + 1)} className="tap grid w-11 place-items-center rounded-lg hover:bg-surface"><ChevronLeft size={18} /></button>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1">{MONTH_NAMES.map((name, index) => {
        const active = selected && selected.year === year && selected.month === index + 1;
        return <button key={name} type="button" autoFocus={active || (!selected && today.year === year && today.month === index + 1)} onClick={() => pick({ year, month: index + 1 })}
          className={`min-h-10 rounded-lg text-sm ${active ? 'bg-accent font-bold text-on-fill' : 'hover:bg-surface'}`}>{name}</button>;
      })}</div>
    </div>}
  </div>;
}
