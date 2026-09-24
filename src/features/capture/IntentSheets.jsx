import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits } from '../../lib/format.js';
import { invoiceLinesTotal } from '../../../shared/voiceIntent.js';
import { matchSettleTargets } from '../../../shared/settleSpeech.js';

/**
 * کارت تأیید نیت‌های ساختاری (طلب، بدهی، چک).
 *
 * جهت پول مهم‌ترین چیزی است که می‌تواند غلط باشد، پس همیشه به‌صورت دو دکمهٔ
 * صریح نشان داده می‌شود — حتی وقتی تشخیص مطمئن است. جملهٔ مبهم بدون انتخاب
 * کاربر اصلاً ذخیره نمی‌شود.
 */
export function IntentSheet({ draft, setDraft, accounts = [], close, confirm }) {
  const [busy, setBusy] = useState(false);
  const [availableTaxRates, setAvailableTaxRates] = useState([]);

  // نرخ‌ها فقط وقتی گرفته می‌شوند که سند فاکتور باشد؛ بقیهٔ نیت‌ها مالیات ندارند.
  useEffect(() => {
    if (draft.intent !== 'invoice') return;
    let cancelled = false;
    api.taxRates()
      .then((response) => { if (!cancelled) setAvailableTaxRates((response.items || []).filter((rate) => rate.active && rate.treatment === 'taxable')); })
      .catch(() => { if (!cancelled) setAvailableTaxRates([]); });
    return () => { cancelled = true; };
  }, [draft.intent]);

  const patchLine = (index, changes) => setDraft({
    ...draft,
    lines: (draft.lines || []).map((line, position) => (position === index ? { ...line, ...changes } : line)),
  });
  const linesTotal = invoiceLinesTotal(draft);
  const isCheque = draft.intent === 'cheque';
  const isInvoice = draft.intent === 'invoice';
  const isCapital = draft.intent === 'capital';
  const isAsset = draft.intent === 'fixed-asset';
  const isEquityMove = isCapital || isAsset;
  const hasAmount = Number(draft.amount) > 0;
  // چک بدون پاسخ «بابت چه؟» ثبت نمی‌شود: پیش‌فرض «معاملهٔ تازه» همان فروش را
  // دو بار در درآمد می‌آورد وقتی چک بابت طلب قبلی بود.
  const chequeReady = !isCheque || (['income', 'receivable'].includes(draft.against) && Boolean(String(draft.contactName || '').trim()));
  const ready = isInvoice ? true
    : isEquityMove ? Boolean(String(draft.title || '').trim())
      : Boolean(draft.direction) && hasAmount && chequeReady;
  const label = isInvoice ? 'فاکتور' : isCapital ? 'سرمایه' : isAsset ? 'دارایی ثابت' : isCheque ? 'چک' : 'طلب و بدهی';
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    await confirm(draft);
    setBusy(false);
  };
  return <div className="fixed inset-0 z-[77] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]">
    <section role="dialog" aria-modal="true" aria-label={isInvoice ? 'تأیید پیش‌نویس فاکتور' : 'تأیید طلب یا بدهی'} className="sheet-in w-full max-w-[560px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl">
      <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
      <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-extrabold text-accent">{label}</span>
      <h2 className="mt-3 text-xl font-extrabold">
        {isInvoice ? 'پیش‌نویس فاکتور ساخته شود؟'
          : isCapital ? 'این آورده به حساب سرمایه برود؟'
            : isAsset ? 'این خرید دارایی ثابت است؟'
              : isCheque ? 'این چک ثبت شود؟' : 'این مورد ثبت شود؟'}
      </h2>
      <blockquote className="mt-3 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{draft.transcript}»</blockquote>

      <div className="mt-4 rounded-[10px] border border-line bg-surface px-3 py-3">
        <p className="text-xs font-bold text-muted">مبلغ</p>
        {draft.needsAmount && !isInvoice && !isEquityMove ? <>
          {/* جمله بیش از یک مبلغ داشت یا مبلغی نگفت؛ حدس نمی‌زنیم، می‌پرسیم. */}
          <input dir="ltr" inputMode="numeric" value={draft.amount || ''} placeholder="مبلغ به تومان"
            onChange={(event) => setDraft({ ...draft, amount: Number(String(event.target.value).replace(/[^\d]/g, '')) || 0 })}
            className="tap mt-1 w-full rounded-lg border border-line bg-paper px-3 text-left text-lg numbers" />
          <p className="mt-1 text-[11px] leading-5 text-expense">
            {draft.amountHint ? 'جمله بیش از یک مبلغ داشت؛ مبلغ همین سند را خودت بنویس.' : 'مبلغ از جمله برداشت نشد؛ خودت بنویس.'}
          </p>
        </> : <b className="numbers mt-1 block text-2xl">{formatAmount(draft.amount)} <span className="text-[12px] font-normal text-muted">تومان</span></b>}
      </div>

      {isEquityMove ? <>
        <label className="mt-3 block text-xs font-bold text-muted">{isCapital ? 'عنوان آورده' : 'نام دارایی'}
          <input value={draft.title || ''} onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder={isCapital ? 'آوردهٔ نقدی مالک' : 'مثلاً لپ‌تاپ، خودرو، دستگاه چاپ'}
            className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink" />
        </label>
        {/* حساب دارایی بی‌نام، ردیفی است که شش ماه بعد هیچ‌کس نمی‌داند چیست. */}
        {isAsset && !String(draft.title || '').trim() && <p className="mt-1 text-[11px] leading-5 text-expense">
          نام دارایی از جمله برداشت نشد؛ خودت بنویس. حساب دارایی بدون نام در دفتر کل قابل پیگیری نیست.
        </p>}

        <div className="mt-3">
          <p className="text-xs font-bold text-muted">{isCapital ? 'پول به کدام حساب آمد؟' : 'پول از کدام حساب رفت؟'}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {accounts.filter((item) => item.active).map((item) => (
              <button key={item.id} onClick={() => setDraft({ ...draft, accountId: item.id })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.accountId === item.id ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{item.name}</button>
            ))}
          </div>
        </div>

        <p className="mt-3 rounded-lg bg-warn-bg px-3 py-3 text-[11px] leading-6 text-accent">
          {isCapital
            ? 'آورده درآمد نیست: در جمع درآمد و سود ماه نمی‌آید و بستانکار حساب سرمایه می‌شود. مانده و کنترل پایان روزِ همان حساب، این پول را می‌بیند.'
            : 'دارایی ثابت هزینهٔ این ماه نیست: به بهای تمام‌شده در دارایی‌ها می‌نشیند و از جمع هزینهٔ دوره بیرون می‌ماند. استهلاک در این نسخه محاسبه نمی‌شود.'}
        </p>
      </> : isInvoice ? <>
        <div className="mt-3">
          <p className="text-xs font-bold text-muted">نوع سند</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[['sales', 'فاکتور فروش'], ['purchase', 'فاکتور خرید']].map(([value, text]) => (
              <button key={value} onClick={() => setDraft({ ...draft, documentType: value })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.documentType === value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{text}</button>
            ))}
          </div>
        </div>

        <label className="mt-3 block text-xs font-bold text-muted">{draft.documentType === 'purchase' ? 'تأمین‌کننده' : 'مشتری'}
          <input value={draft.contactName || ''} onChange={(event) => setDraft({ ...draft, contactName: event.target.value })}
            placeholder={draft.documentType === 'purchase' ? 'تأمین‌کننده متفرقه' : 'مشتری متفرقه'}
            className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink" />
        </label>

        <div className="mt-3">
          <p className="text-xs font-bold text-muted">ردیف‌ها</p>
          <div className="mt-2 space-y-2">
            {(draft.lines || []).map((line, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_58px_minmax(0,110px)] gap-2">
                <input value={line.title} onChange={(event) => patchLine(index, { title: event.target.value })}
                  placeholder="نام کالا یا خدمت" className="tap rounded-lg border border-line bg-surface px-2 text-xs text-ink" />
                <input dir="ltr" inputMode="numeric" value={line.quantity}
                  onChange={(event) => patchLine(index, { quantity: Number(event.target.value) || 0 })}
                  className="tap rounded-lg border border-line bg-surface px-2 text-center text-xs numbers" />
                <input dir="ltr" inputMode="numeric" value={line.unitPrice}
                  onChange={(event) => patchLine(index, { unitPrice: Number(event.target.value) || 0 })}
                  className="tap rounded-lg border border-line bg-surface px-2 text-left text-xs numbers" />
              </div>
            ))}
          </div>
          {!(draft.lines || []).length && <p className="mt-1 text-[11px] leading-5 text-muted">
            نرخ واحد در جمله گفته نشد، پس یک ردیف به کل مبلغ ساخته می‌شود. برای ردیف دقیق بگو
            «ده عدد چای هرکدام پنجاه هزار تومان».
          </p>}
          {(draft.lines || []).length > 0 && <p className="numbers mt-2 text-right text-xs text-muted">
            جمع ردیف‌ها: <b className="text-ink">{formatAmount(linesTotal)}</b> تومان
          </p>}
        </div>

        {/* نرخ مالیات فقط از نرخ‌های تعریف‌شدهٔ همین دفتر می‌آید؛ ساختن نرخ از روی
            حرف، عددی به سند می‌دهد که در دفتر وجود ندارد. */}
        <div className="mt-3">
          <p className="text-xs font-bold text-muted">مالیات</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => setDraft({ ...draft, taxRateId: null })}
              className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${!draft.taxRateId ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>بدون مالیات</button>
            {availableTaxRates.map((rate) => (
              <button key={rate.id} onClick={() => setDraft({ ...draft, taxRateId: rate.id })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.taxRateId === rate.id ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>
                {rate.name} <span className="numbers">({toPersianDigits(rate.rate)}٪)</span>
              </button>
            ))}
          </div>
          {draft.tax?.wanted && !availableTaxRates.length && <p className="mt-1 text-[11px] leading-5 text-expense">
            در جمله مالیات خواسته شد ولی هیچ نرخ فعالی در این دفتر تعریف نشده است. نرخ را در «مالیات» بساز؛
            حساب‌یار نرخ نمی‌سازد چون سند باید به نرخ واقعی دفتر بخورد.
          </p>}
          {draft.tax?.wanted && draft.tax.ratePercent != null && !availableTaxRates.some((rate) => Math.round(rate.rate) === draft.tax.ratePercent) && availableTaxRates.length > 0 && (
            <p className="mt-1 text-[11px] leading-5 text-accent">
              نرخ <span className="numbers">{toPersianDigits(draft.tax.ratePercent)}٪</span> گفته شد ولی در نرخ‌های این دفتر نیست؛ خودت از بالا انتخاب کن.
            </p>
          )}
        </div>

        <label className="mt-3 flex items-start gap-2 text-[12px] leading-6">
          <input type="checkbox" checked={draft.issueNow === true}
            onChange={(event) => setDraft({ ...draft, issueNow: event.target.checked })} className="mt-1" />
          <span>همین حالا صادر شود {draft.occurredAt ? <>با تاریخ <b>{persianDate(draft.occurredAt)}</b></> : '(با تاریخ امروز)'}</span>
        </label>

        <p className="mt-3 rounded-lg bg-warn-bg px-3 py-3 text-[11px] leading-6 text-accent">
          {draft.issueNow
            ? 'سند صادر می‌شود: در دفتر کل سند می‌خورد، در گزارش مالیاتی می‌آید و در جمع طلب و بدهی می‌نشیند. پس از صدور، اصلاحش سند برگشتی می‌خواهد.'
            : 'سند به‌صورت پیش‌نویس می‌ماند: نه در دفتر کل سند می‌خورد، نه در گزارش مالیاتی می‌آید و نه در جمع طلب و بدهی. هر وقت خواستی از برگهٔ «فاکتورها» صادرش کن.'}
        </p>
      </> : <>
        <div className="mt-3">
          <p className="text-xs font-bold text-muted">جهت</p>
          {draft.ambiguous && <p className="mt-1 text-[11px] leading-5 text-expense">جمله هم نشانهٔ طلب داشت هم بدهی؛ خودت انتخاب کن.</p>}
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[['receivable', 'طلب ما (بدهکار است)'], ['payable', 'بدهی ما (طلبکار است)']].map(([value, text]) => (
              <button key={value} onClick={() => setDraft({ ...draft, direction: value, ambiguous: false })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.direction === value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{text}</button>
            ))}
          </div>
        </div>

        {isCheque ? <>
          <label className="mt-3 block text-xs font-bold text-muted">{draft.direction === 'payable' ? 'گیرندهٔ چک' : 'صاحب چک'}
            <input value={draft.contactName || ''} onChange={(event) => setDraft({ ...draft, contactName: event.target.value })}
              placeholder="نام شخص یا شرکت" className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink" />
          </label>
          <div className="mt-3">
            <p className="text-xs font-bold text-muted">این چک بابت چیست؟</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(draft.direction === 'payable'
                ? [['income', 'خرید یا هزینهٔ تازه'], ['receivable', 'بدهی قبلی ما']]
                : [['income', 'فروش تازه'], ['receivable', 'طلب قبلی ما']]).map(([value, text]) => (
                <button key={value} onClick={() => setDraft({ ...draft, against: value })}
                  className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.against === value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{text}</button>
              ))}
            </div>
            <p className="mt-2 rounded-lg bg-warn-bg px-3 py-2 text-[11px] leading-6 text-accent">
              {draft.against === 'receivable'
                ? 'بابت حساب قبلی است، پس درآمد یا هزینهٔ تازه‌ای شناسایی نمی‌شود؛ فقط شکل طلب یا بدهی به چک عوض می‌شود.'
                : draft.against === 'income'
                  ? 'بابت معاملهٔ تازه است، پس همین حالا درآمد یا هزینه شناسایی می‌شود. اگر بابت حساب قبلی است، گزینه را عوض کن وگرنه همان معامله دو بار در سود می‌آید.'
                  : 'تا انتخاب نکنی ثبت نمی‌شود: اگر بابت حساب قبلی باشد و «تازه» ثبت شود، همان معامله دو بار در سود دوره می‌آید.'}
            </p>
          </div>
        </> : <label className="mt-3 block text-xs font-bold text-muted">عنوان
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink" />
        </label>}

        {draft.occurredAt && <p className="mt-3 text-xs text-muted">تاریخ بدهکار/طلبکار شدن: <b className="text-ink">{persianDate(draft.occurredAt)}</b></p>}
      {draft.dueAt && <p className="mt-1 text-xs text-muted">سررسید: <b className="text-ink">{persianDate(draft.dueAt)}</b></p>}
      </>}

      <div className="mt-5 grid grid-cols-[2fr_1fr] gap-2">
        <button disabled={busy || !ready} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">
          {busy ? 'در حال ثبت…' : isInvoice ? 'پیش‌نویس بساز' : 'ثبت کن'}
        </button>
        <button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button>
      </div>
    </section>
  </div>;
}

/**
 * انتخاب و تأیید تسویهٔ یک سند موجود.
 *
 * خطر این مسیر از ساختن سند بیشتر است: تسویهٔ سند اشتباه یعنی پول در جای
 * اشتباه جابه‌جا می‌شود و یک سند باز، بسته اعلام می‌شود. پس هیچ سندی خودکار
 * تسویه نمی‌شود — حتی وقتی فقط یک گزینه بخورد، کاربر باید همان یکی را تأیید کند.
 */
export function SettleSheet({ draft, obligations = [], close, confirm }) {
  const [invoices, setInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (draft.bounced) { setLoadingInvoices(false); return undefined; }
    let cancelled = false;
    api.invoices()
      .then((response) => { if (!cancelled) setInvoices(response.items || []); })
      .catch(() => { if (!cancelled) setInvoices([]); })
      .finally(() => { if (!cancelled) setLoadingInvoices(false); });
    return () => { cancelled = true; };
  }, [draft.bounced]);

  const targets = draft.bounced ? [] : matchSettleTargets(draft, { invoices, obligations });
  const selected = targets.find((item) => item.id === selectedId) || null;
  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    await confirm(selected, { occurredAt: draft.occurredAt });
    setBusy(false);
  };

  return <div className="fixed inset-0 z-[77] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]">
    <section role="dialog" aria-modal="true" aria-label="تأیید تسویه" className="sheet-in w-full max-w-[560px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl">
      <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
      <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-extrabold text-accent">تسویه</span>
      <h2 className="mt-3 text-xl font-extrabold">{draft.bounced ? 'چک برگشتی تسویه نمی‌شود' : 'کدام سند تسویه شود؟'}</h2>
      <blockquote className="mt-3 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{draft.transcript}»</blockquote>

      {draft.bounced ? <p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-[12px] leading-6 text-accent">
        برگشت چک، تسویه نیست: سند همچنان باز می‌ماند و معمولاً پیگیری حقوقی یا ثبت هزینهٔ جداگانه می‌خواهد.
        حساب‌یار عمداً کاری انجام نمی‌دهد تا یک سند باز، بسته اعلام نشود.
      </p> : <>
        {loadingInvoices && <p className="mt-4 text-sm text-muted">در حال خواندن سندهای باز…</p>}

        {!loadingInvoices && !targets.length && <p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-[12px] leading-6 text-accent">
          سند بازی که با این توضیح بخورد پیدا نشد. شاید نام یا مبلغ فرق دارد، یا سند هنوز صادر نشده است
          — پیش‌نویس تسویه نمی‌شود.
        </p>}

        {targets.length > 1 && <p className="mt-4 text-[12px] leading-6 text-expense">
          {toPersianDigits(targets.length)} سند با این توضیح می‌خورد. خودت انتخاب کن؛ حساب‌یار حدس نمی‌زند
          چون تسویهٔ سند اشتباه، پول را در جای اشتباه جابه‌جا می‌کند.
        </p>}

        <div className="mt-3 space-y-2">
          {targets.map((target) => (
            <button key={target.id} onClick={() => setSelectedId(target.id)}
              className={`tap flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-right ${selectedId === target.id ? 'border-accent bg-accent/10' : 'border-line bg-surface'}`}>
              <span className="min-w-0">
                <b className="block truncate text-sm">{target.label}</b>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {target.kind === 'invoice' ? 'فاکتور' : target.direction === 'receivable' ? 'طلب ما' : 'بدهی ما'}
                  {target.name ? ` · ${target.name}` : ''}
                </span>
              </span>
              <b className="numbers shrink-0 text-sm">{formatAmount(target.amount)}</b>
            </button>
          ))}
        </div>

        {draft.occurredAt && <p className="mt-3 text-xs text-muted">تاریخ تسویه: <b className="text-ink">{persianDate(draft.occurredAt)}</b></p>}
      </>}

      <div className="mt-5 grid grid-cols-[2fr_1fr] gap-2">
        {!draft.bounced && <button disabled={busy || !selected} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال تسویه…' : 'تسویه کن'}</button>}
        <button disabled={busy} onClick={close} className={`tap rounded-lg border border-line bg-surface font-bold ${draft.bounced ? 'col-span-2' : ''}`}>{draft.bounced ? 'باشه' : 'لغو'}</button>
      </div>
    </section>
  </div>;
}
