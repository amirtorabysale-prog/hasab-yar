import { ArrowRight, Search, TriangleAlert, Wallet } from 'lucide-react';
import { JournalEntrySheet } from '../accounting/JournalEntrySheet.jsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

/**
 * تاریخ کوتاه، بدون نام روز هفته.
 *
 * «دوشنبه ۱۴ اردیبهشت» روی موبایل آن‌قدر پهن است که شمارهٔ سند — تنها چیزی
 * که ردیف را قابل شناسایی می‌کند — بریده می‌شود. در یک کارت حساب، روز هفته
 * هیچ کاری نمی‌کند.
 */
const shortDateFormat = new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'short', timeZone: 'Asia/Tehran' });
const shortDate = (iso) => { const parsed = new Date(iso); return Number.isNaN(parsed.getTime()) ? '—' : shortDateFormat.format(parsed); };

/**
 * کارت حساب طرف حساب.
 *
 * چیزی که حسابدار از یک کارت می‌خواهد سه‌تاست و هر سه باید بدون اسکرول دیده
 * شوند: این شخص الان چقدر بدهکار یا بستانکار است، این عدد از کجا آمده، و هر
 * ردیف مانده را به کجا رساند. ستون مانده همان چیزی است که کارت را از یک
 * فهرست ساده جدا می‌کند.
 *
 * مانده مثبت یعنی او به ما بدهکار است، منفی یعنی ما به او. رنگ از همین
 * می‌آید نه از نوع ردیف: کارت دربارهٔ یک رابطه است، نه دربارهٔ تک‌تک سندها.
 */

const KIND_LABELS = { person: 'شخص', customer: 'مشتری', vendor: 'تأمین‌کننده' };
// پرسنل و شریک نقش‌اند روی «شخص» (shared/partyRole.js)؛ نقش بر نوع مقدم است.
const ROLE_LABELS = { employee: 'پرسنل', partner: 'شریک' };
const contactLabel = (contact) => ROLE_LABELS[contact.role] || KIND_LABELS[contact.kind] || 'شخص';

/** صفر واقعاً «تسویه» است و باید جور دیگری دیده شود، نه یک عددِ بی‌رنگ. */
function balanceTone(balance) {
  if (!balance) return { label: 'تسویه', className: 'text-muted' };
  return balance > 0
    ? { label: 'بدهکار', className: 'text-income' }
    : { label: 'بستانکار', className: 'text-expense' };
}

/** در فهرست، مبلغ و جهتش کنار هم؛ واحد پول آنجا جا نمی‌گیرد و لازم هم نیست. */
function BalanceBadge({ balance }) {
  const tone = balanceTone(balance);
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      <span className={`numbers text-sm font-extrabold ${tone.className}`}>{formatAmount(Math.abs(balance))}</span>
      <span className={`text-xs font-extrabold ${tone.className}`}>{tone.label}</span>
    </span>
  );
}

function Stat({ label, value, tone = '' }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className={`numbers mt-1 text-sm font-extrabold ${tone}`}>{formatAmount(value)}</p>
    </div>
  );
}

/**
 * یک ردیف گردش.
 *
 * نام حساب عمداً فقط وقتی نشان داده می‌شود که کارت بیش از یک حساب داشته
 * باشد — مثلاً هم دریافتنی و هم چک. وقتی همه از یک حساب‌اند، تکرارِ «حساب
 * دریافتنی — فلانی» زیر هر ردیف فقط نویز است؛ کل کارت مالِ همان شخص است.
 *
 * روی موبایل ستون جدا جا نمی‌شود، پس جهت با علامت گفته می‌شود: مثبت یعنی
 * بدهکار شد، منفی یعنی بستانکار. بدون علامت، دو عددِ بی‌برچسب کنار هم
 * می‌نشستند و خواندنشان حدس می‌خواست.
 */
function StatementRow({ line, showAccount, open }) {
  const tone = balanceTone(line.balance);
  // هر ردیف به سند خودش ارجاع می‌دهد.
  return (
    <article role="button" tabIndex={0} onClick={() => open(line)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(line); } }}
      title={line.entryId ? 'نمایش سند حسابداری' : 'این ردیف هنوز سند قطعی ندارد'}
      className="-mx-2 cursor-pointer rounded-lg px-2 py-3 hover:bg-accent/5 focus:bg-accent/5 focus:outline-none sm:grid sm:grid-cols-[74px_1fr_118px_118px_150px] sm:items-baseline sm:gap-x-3">
      <div className="flex items-baseline justify-between gap-3 sm:contents">
        <time className="numbers shrink-0 text-xs text-muted">{shortDate(line.occurredAt)}</time>
        <div className="min-w-0 flex-1 sm:order-none">
          <p className="truncate text-[13px] font-bold">{line.title || 'بدون شرح'}</p>
          {showAccount && <p className="truncate text-xs text-muted">{line.accountName}</p>}
        </div>
        <span className={`numbers shrink-0 text-[13px] font-extrabold sm:hidden ${line.debit ? 'text-income' : 'text-expense'}`}>
          {line.debit ? `+ ${formatAmount(line.debit)}` : `− ${formatAmount(line.credit)}`}
        </span>
      </div>

      <p className="numbers hidden text-right text-[13px] font-bold text-income sm:block">
        {line.debit ? formatAmount(line.debit) : <span className="text-line">—</span>}
      </p>
      <p className="numbers hidden text-right text-[13px] font-bold text-expense sm:block">
        {line.credit ? formatAmount(line.credit) : <span className="text-line">—</span>}
      </p>
      <p className={`numbers mt-1 text-[12px] font-extrabold sm:mt-0 sm:text-right ${tone.className}`}>
        <span className="ml-1 text-xs font-normal text-muted sm:hidden">مانده</span>
        {formatAmount(Math.abs(line.balance))}
        <span className="mr-1 text-xs font-bold"> {tone.label}</span>
      </p>
    </article>
  );
}

/**
 * وقتی فهرست یک عدد می‌گوید و کارت عدد دیگری، کاربر به هیچ‌کدام اعتماد
 * نمی‌کند.
 *
 * کارت از دفتر کل می‌خواند و فهرست از جدول تعهد و فاکتور. سندی که طرف
 * حسابش موقع ثبت وصل نبوده، در دفتر کل حسابی به نام خودش می‌سازد که به این
 * شخص نمی‌چسبد — آن‌وقت فهرست مبلغ را می‌دید و کارت «تسویه» می‌گفت.
 *
 * حالا کارت همان اختلاف را می‌گوید و دلیلش را هم. پنهان‌کردنش بدترین کار
 * ممکن بود: عددِ غلطِ مطمئن، از عددِ نبودن هم بدتر است.
 */
function UnexplainedNotice({ reconciliation }) {
  const gap = Math.abs(reconciliation.unexplained);
  const tone = balanceTone(reconciliation.unexplained);
  return (
    <section className="mt-4 rounded-2xl border border-accent/40 bg-warn-bg p-4">
      <p className="flex items-center gap-2 text-[12px] font-extrabold text-accent">
        <TriangleAlert size={16} /> این کارت کامل نیست
      </p>
      <p className="mt-2 text-[13px] leading-7">
        {toPersianDigits(reconciliation.openCount)} سند باز به مبلغ{' '}
        <b className={`numbers ${tone.className}`}>{formatAmount(gap)}</b> {unitLabel()} {tone.label} برای این طرف حساب ثبت
        شده که در دفتر کل به حساب او نچسبیده، پس در گردش پایین دیده نمی‌شود.
      </p>
      <p className="mt-2 text-xs leading-6 text-muted">
        معمولاً یعنی آن سند وقتی ثبت شده که طرف حسابش انتخاب نشده بود. با باز کردن همان سند در «طلب و بدهی» یا
        «فاکتور» و انتخاب این شخص، گردشش به همین کارت می‌آید.
      </p>
    </section>
  );
}

function ContactList({ contacts, onOpen }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim();
    if (!needle) return contacts;
    return contacts.filter((contact) => contact.name.includes(needle) || String(contact.phone || '').includes(needle));
  }, [contacts, query]);

  return (
    <section className="mt-5">
      <label className="flex min-h-12 items-center gap-2 rounded-lg border border-line bg-surface px-3 hover:bg-paper hover:text-ink">
        <Search size={18} className="text-muted" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="جست‌وجوی نام یا شماره"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      <p className="mt-3 text-xs text-muted">{toPersianDigits(filtered.length)} طرف حساب</p>

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] leading-7 text-muted">
          {contacts.length ? 'با این جست‌وجو چیزی پیدا نشد.' : 'هنوز طرف حسابی ثبت نشده است. با اولین فاکتور یا طلب، خودش ساخته می‌شود.'}
        </p>
      ) : (
        <div className="mt-2 divide-y divide-line border-y border-line">
          {filtered.map((contact) => (
            <button
              key={contact.id}
              onClick={() => onOpen(contact)}
              className="tap flex w-full items-center gap-3 py-3 text-right"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-paper text-[13px] font-extrabold text-muted">
                {contact.name.trim().slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-extrabold">{contact.name}</span>
                <span className="block text-xs text-muted">
                  {contactLabel(contact)}
                  {contact.openCount ? ` · ${toPersianDigits(contact.openCount)} سند باز` : ''}
                </span>
              </span>
              <BalanceBadge balance={Number(contact.balance || 0)} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Card({ contact, onBack, notify }) {
  const [card, setCard] = useState(null);
  const [openLine, setOpenLine] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCard(await api.contactCard(contact.id)); }
    catch (error) { notify(error.message); setCard(null); }
    finally { setLoading(false); }
  }, [contact.id, notify]);

  useEffect(() => { load(); }, [load]);

  const tone = balanceTone(card?.totals?.balance || 0);
  // چند حساب یعنی کارت هم دریافتنی دارد و هم چک؛ آن‌وقت نام حساب معنا دارد.
  const manyAccounts = new Set((card?.lines || []).map((line) => line.accountName)).size > 1;
  // اختلاف بین سندهای باز و آنچه دفتر کل نشان می‌دهد.
  const gap = card?.reconciliation?.unexplained || 0;

  return (
    <section className="mt-5">
      <button onClick={onBack} className="tap -mr-2 flex items-center gap-1 text-sm font-bold text-muted">
        <ArrowRight size={18} /> همهٔ طرف حساب‌ها
      </button>

      <header className="mt-3 rounded-2xl border border-line bg-surface p-4">
        <p className="text-xs font-bold text-muted">{contactLabel(contact)}</p>
        <h2 className="mt-1 text-xl font-extrabold">{contact.name}</h2>
        {contact.phone && <p className="numbers mt-1 text-[12px] text-muted">{toPersianDigits(contact.phone)}</p>}
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs text-muted">مانده حساب</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={`numbers text-[28px] font-extrabold leading-none ${tone.className}`}>{formatAmount(Math.abs(card?.totals?.balance || 0))}</span>
            <small className="text-[13px] text-muted">{unitLabel()}</small>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-extrabold ${tone.className} ${card?.totals?.balance ? 'border-current' : 'border-line'}`}>{tone.label}</span>
          </p>
          <p className="mt-1 text-xs leading-6 text-muted">
            {!card?.totals?.balance ? 'حساب این طرف تسویه است.'
              : tone.label === 'بدهکار' ? 'این مبلغ را از او طلب داریم.' : 'این مبلغ را به او بدهکاریم.'}
          </p>
          {/* مانده به تفکیک: حساب تجاری، جاری شریک، و پیش‌دریافت/پیش‌پرداخت/وام/ودیعه/مساعده. */}
          {(() => {
            const groups = card?.totals?.byGroup;
            if (!groups) return null;
            const shown = [['trade', 'طلب و بدهی تجاری'], ['partner', 'جاری شریک'], ['other', 'پیش‌دریافت، پیش‌پرداخت، وام و مساعده']]
              .filter(([key]) => groups[key]);
            if (shown.length < 2 && !groups.partner && !groups.other) return null;
            return <ul className="mt-2 space-y-1 text-[12px]">
              {shown.map(([key, label]) => <li key={key} className="flex items-center justify-between gap-3">
                <span className="text-muted">{label}</span>
                <span className="numbers font-bold">{formatAmount(Math.abs(groups[key]))} <small className="text-muted">{groups[key] > 0 ? 'بدهکار' : 'بستانکار'}</small></span>
              </li>)}
            </ul>;
          })()}
        </div>
      </header>

      {loading ? (
        <div className="mt-6 grid place-items-center py-10" role="status" aria-label="در حال باز شدن کارت">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
        </div>
      ) : !card?.lines?.length ? (
        gap ? <UnexplainedNotice reconciliation={card.reconciliation} /> : (
          <p className="mt-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] leading-7 text-muted">
            هنوز گردشی برای این طرف حساب در دفتر ثبت نشده است.
            <br />
            با اولین فاکتور، تسویه یا چک، همین‌جا دیده می‌شود.
          </p>
        )
      ) : (
        <>
          {gap ? <UnexplainedNotice reconciliation={card.reconciliation} /> : null}
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Stat label="افتتاحیه" value={Math.abs(card.opening)} />
            <Stat label="گردش بدهکار" value={card.totals.debit} tone="text-income" />
            <Stat label="گردش بستانکار" value={card.totals.credit} tone="text-expense" />
          </div>

          <div className="mt-5 flex items-baseline justify-between">
            <h3 className="text-sm font-extrabold">گردش حساب</h3>
            <p className="text-xs text-muted">
              {toPersianDigits(card.lines.length)} ردیف از {toPersianDigits(card.totals.documents)} سند
            </p>
          </div>

          <div className="mt-2 hidden grid-cols-[74px_1fr_118px_118px_150px] gap-x-3 border-b border-line pb-2 text-xs font-bold text-muted sm:grid">
            <span>تاریخ</span><span>شرح</span>
            <span className="text-right">بدهکار</span><span className="text-right">بستانکار</span><span className="text-right">مانده</span>
          </div>
          <div className="divide-y divide-line border-b border-line sm:border-t-0">
            {card.lines.map((line) => <StatementRow key={line.id} line={line} showAccount={manyAccounts} open={setOpenLine} />)}
          </div>
        </>
      )}
      {openLine && <JournalEntrySheet line={openLine} close={() => setOpenLine(null)} />}
    </section>
  );
}

export function CounterpartyCardPanel({ contacts = [], notify }) {
  const [selected, setSelected] = useState(null);

  if (!contacts.length && !selected) {
    return (
      <section className="mt-8 grid place-items-center rounded-2xl border border-dashed border-line px-4 py-12 text-center">
        <Wallet className="text-line" size={32} />
        <p className="mt-3 text-sm font-extrabold">هنوز طرف حسابی نداری</p>
        <p className="mt-1 max-w-[280px] text-[12px] leading-7 text-muted">
          هر شخص یا شرکتی که با او فاکتور، طلب یا چک داشته باشی، اینجا کارت خودش را می‌گیرد.
        </p>
      </section>
    );
  }

  return selected
    ? <Card contact={selected} onBack={() => setSelected(null)} notify={notify} />
    : <ContactList contacts={contacts} onOpen={setSelected} />;
}

export default CounterpartyCardPanel;
