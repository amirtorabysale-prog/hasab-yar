import { useState } from 'react';

/**
 * کارت سؤال موتور تصمیم — وقتی موتور یک واقعیت لازم را ندارد.
 *
 * گزینه، هرجا که جواب شمردنی باشد. کاربری که روی «از اول ماه بعد» می‌زند هیچ
 * جمله‌ای برای تفسیر باقی نمی‌گذارد، و جواب از همان اول به مورد درست چسبیده
 * است چون روی کارت خودش زده شده. هر بار فقط یک سؤال: فرم یعنی کاربر باید همه
 * را با هم بداند، و کسی که یکی را نمی‌داند کل کار را رها می‌کند.
 *
 * صف حسابدار و کارت «یک سؤال کوتاه» صفحهٔ امروز هر دو همین کارت را نشان
 * می‌دهند، چون هر دو به همان سؤال (`decision.question`) و همان مسیر جواب
 * (`applyAnswer`) می‌رسند. دو کارت جدا یعنی یکی گزینه‌ها را نشان می‌دهد و دیگری
 * فقط «بله»ای که تا جواب نیامده حتماً رد می‌شود.
 *
 * حالتِ پاسخ نیمه‌کاره به همان سؤالی بسته است که برایش باز شد. بعد از جواب
 * «شروع دوره» سؤال بعدی «پایان دوره» است و هر دو گزینهٔ آزاد `custom` دارند؛ اگر
 * متن تایپ‌شده با سؤال عوض نشود، یک کلیک «۱ مهر ۱۴۰۵» را پایان دوره هم
 * می‌فرستد — دوره‌ای یک‌روزه که کل پیش‌پرداخت یک‌ساله را یک‌جا هزینه می‌کرد.
 * جای استفاده هم کارت را با `questionCardKey` کلید می‌زند تا با هر تصمیم تازه از
 * نو ساخته شود.
 */
export function DecisionQuestionCard({ question, busy, onAnswer }) {
  const [draft, setDraft] = useState({ fact: null, option: null, text: '' });
  const current = draftForQuestion(draft, question);
  const setText = (text) => setDraft({ ...current, text });
  const options = question.options || [];
  const freeFor = current.option != null && options.find((option) => option.freeInput && option.value === current.option) || null;
  const submitText = () => onAnswer(freeFor
    ? { fact: question.fact, value: freeFor.value, freeText: current.text.trim() }
    : { fact: question.fact, freeText: current.text.trim() });

  return <div className="mt-2 rounded-[10px] border border-accent/40 bg-accent/5 p-3">
    <p className="text-[12px] font-extrabold text-ink">{question.text}</p>
    {question.kind === 'options' && options.length > 0
      ? <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option) => <button
            key={String(option.value)}
            disabled={busy}
            onClick={() => (option.freeInput ? setDraft({ fact: question.fact, option: option.value, text: '' }) : onAnswer({ fact: question.fact, value: option.value }))}
            className={`tap rounded-lg border px-3 py-1 text-[12px] font-bold disabled:opacity-40 ${freeFor?.value === option.value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-paper'}`}>
            {option.label}
          </button>)}
        </div>
      : <div className="mt-2 flex gap-1.5">
          <input aria-label={question.text} value={current.text} onChange={(event) => setText(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1 text-[12px]" />
          <button disabled={busy || !current.text.trim()} onClick={submitText}
            className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white disabled:opacity-40">ثبت پاسخ</button>
        </div>}

    {/* گزینهٔ «خودم می‌گویم» یک مقدار نیست؛ ورودی آزاد می‌خواهد. */}
    {freeFor && <div className="mt-2 flex gap-1.5">
      <input aria-label={freeFor.label} value={current.text} onChange={(event) => setText(event.target.value)} placeholder={freeFor.label}
        className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1 text-[12px]" />
      <button disabled={busy || !current.text.trim()} onClick={submitText}
        className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white disabled:opacity-40">ثبت پاسخ</button>
    </div>}
  </div>;
}

/**
 * کلید کارت سؤال: رویداد (یا تصمیم) به‌علاوهٔ واقعیتی که پرسیده می‌شود. ردیف
 * صف با `item.id` کلید می‌خورد و بعد از هر جواب همان می‌ماند؛ بدون این کلید
 * React همان کارت قبلی را برای سؤال بعدی هم نگه می‌دارد.
 */
export function questionCardKey(scope, question) {
  return `${scope || ''}:${question?.fact || ''}`;
}

/**
 * پاسخ نیمه‌کاره فقط برای همان سؤالی معتبر است که برایش باز شد؛ برای سؤال
 * دیگر، کارت خالی است.
 */
export function draftForQuestion(draft, question) {
  return draft?.fact && draft.fact === question?.fact ? draft : { fact: question?.fact || null, option: null, text: '' };
}
