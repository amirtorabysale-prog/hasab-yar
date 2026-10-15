import { ArrowRight, Landmark, Plus, TriangleAlert, Users, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BANKS, bankById } from '../../../shared/banks.js';
import { api } from '../../lib/api.js';
import { digitsOnly } from '../../components/common.jsx';
import { formatAmount, toPersianDigits } from '../../lib/format.js';
import { CounterpartyCardPanel } from './CounterpartyCardPanel.jsx';
import { JournalEntrySheet } from '../accounting/JournalEntrySheet.jsx';

/**
 * کارت حساب برای همهٔ حساب‌ها — بانک، صندوق و تنخواه، اشخاص و شرکت‌ها.
 *
 * درخواست مالک محصول، مهر ۱۴۰۵: «برای هر حسابی باید کارت حساب داشته باشیم.
 * در بخش بانک‌ها باید امکان تعریف بانک باشد و هر بانکی انتخاب شود کارت حسابش
 * بیاید؛ افراد و شرکت‌ها هم همین‌طور.» تا امروز فقط اشخاص کارت داشتند، آن هم
 * فقط وقتی سندی خودش آن‌ها را ساخته بود؛ بانک فقط یک عدد در تنظیمات بود.
 */

const shortDateFormat = new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'short', timeZone: 'Asia/Tehran' });
const shortDate = (iso) => { const parsed = new Date(iso); return Number.isNaN(parsed.getTime()) ? '—' : shortDateFormat.format(parsed); };

const SECTIONS = [
  ['banks', 'بانک‌ها', Landmark],
  ['cash', 'صندوق و تنخواه', Wallet],
  ['people', 'اشخاص و شرکت‌ها', Users],
];
const CASH_KINDS = { cash: 'صندوق', wallet: 'کیف پول', other: 'سایر', petty: 'تنخواه' };

function Stat({ label, value, tone = '' }) {
  return (
    <div className="rounded-[10px] border border-line bg-surface px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className={`numbers mt-1 text-sm font-extrabold ${tone}`}>{formatAmount(value)}</p>
    </div>
  );
}

/** یک ردیف گردشِ بانک یا صندوق: ورود سبز، خروج قرمز، و مانده پس از آن. */
function MoneyRow({ line, open }) {
  // هر ردیف به سند خودش ارجاع می‌دهد.
  return (
    <article role="button" tabIndex={0} onClick={() => open(line)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(line); } }}
      title={line.entryId ? 'نمایش سند حسابداری' : 'این ردیف هنوز سند قطعی ندارد'}
      className="-mx-2 cursor-pointer rounded-lg px-2 py-3 hover:bg-accent/5 focus:bg-accent/5 focus:outline-none">
      <div className="flex items-baseline justify-between gap-3">
        <time className="numbers shrink-0 text-xs text-muted">{shortDate(line.occurredAt)}</time>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold">{line.title || 'بدون شرح'}</p>
          {line.counterpart && <p className="truncate text-xs text-muted">{line.debit ? 'از' : 'به'} {line.counterpart}</p>}
        </div>
        <span className={`numbers shrink-0 text-[13px] font-extrabold ${line.debit ? 'text-income' : 'text-expense'}`}>
          {line.debit ? `+ ${formatAmount(line.debit)}` : `− ${formatAmount(line.credit)}`}
        </span>
      </div>
      <p className={`numbers mt-1 text-left text-[12px] font-extrabold ${line.balance < 0 ? 'text-expense' : ''}`}>
        <span className="ml-1 text-xs font-normal text-muted">مانده</span>{line.balance < 0 ? '− ' : ''}{formatAmount(Math.abs(line.balance))}
      </p>
    </article>
  );
}

function MoneyCard({ account, onBack, notify }) {
  const [openLine, setOpenLine] = useState(null);
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setCard(await api.accountCard(account.id)); }
    catch (error) { notify(error.message); setCard(null); }
    finally { setLoading(false); }
  }, [account.id, notify]);
  useEffect(() => { load(); }, [load]);

  const bank = account.bankId ? bankById(account.bankId) : null;
  const balance = card?.totals?.balance ?? Number(account.balance || 0);
  const gap = card?.reconciliation?.unexplained || 0;
  return (
    <section className="mt-5">
      <button onClick={onBack} className="tap -mr-2 flex items-center gap-1 text-sm font-bold text-muted">
        <ArrowRight size={18} /> همهٔ حساب‌ها
      </button>
      <header className="mt-3 rounded-[12px] border border-line bg-surface p-4">
        <p className="text-xs font-bold text-muted">{account.kind === 'bank' ? (bank?.name || 'بانک') : CASH_KINDS[account.kind] || 'حساب'}</p>
        <h2 className="mt-1 text-xl font-extrabold">{account.name}</h2>
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs text-muted">موجودی</p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className={`numbers text-[28px] font-extrabold leading-none ${balance < 0 ? 'text-expense' : ''}`}>{balance < 0 ? '− ' : ''}{formatAmount(Math.abs(balance))}</span>
            <small className="text-[13px] text-muted">تومان</small>
          </p>
          {balance < 0 && <p className="mt-1 text-xs text-expense">موجودی منفی است؛ برداشتی ثبت شده که پولش در این حساب نبوده.</p>}
        </div>
      </header>
      {gap ? (
        <section className="mt-4 rounded-[12px] border border-accent/40 bg-warn-bg p-4">
          <p className="flex items-center gap-2 text-[12px] font-extrabold text-accent"><TriangleAlert size={16} /> این کارت کامل نیست</p>
          <p className="mt-2 text-[13px] leading-7">
            موجودیِ فهرست حساب‌ها <b className="numbers">{formatAmount(card.reconciliation.listed)}</b> است و دفتر کل <b className="numbers">{formatAmount(card.reconciliation.ledger)}</b>.
            معمولاً یعنی ثبتی هنوز سند نخورده است، مثلاً در صف بررسی مانده.
          </p>
        </section>
      ) : null}
      {loading ? (
        <div className="mt-6 grid place-items-center py-10" role="status" aria-label="در حال باز شدن کارت">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
        </div>
      ) : !card?.lines?.length ? (
        <p className="mt-6 rounded-[10px] border border-dashed border-line px-4 py-8 text-center text-[13px] leading-7 text-muted">
          هنوز گردشی برای این حساب ثبت نشده است.
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Stat label="واریز" value={card.totals.debit} tone="text-income" />
            <Stat label="برداشت" value={card.totals.credit} tone="text-expense" />
            <Stat label="ردیف" value={card.lines.length} />
          </div>
          <div className="mt-5 flex items-baseline justify-between">
            <h3 className="text-sm font-extrabold">گردش حساب</h3>
            <p className="text-xs text-muted">{toPersianDigits(card.lines.length)} ردیف از {toPersianDigits(card.totals.documents)} سند</p>
          </div>
          <div className="mt-2 divide-y divide-line border-y border-line">
            {[...card.lines].reverse().map((line) => <MoneyRow key={line.id} line={line} open={setOpenLine} />)}
          </div>
        </>
      )}
      {openLine && <JournalEntrySheet line={openLine} close={() => setOpenLine(null)} />}
    </section>
  );
}

/** تعریف بانک یا صندوق تازه — بانک از فهرست انتخاب می‌شود تا گفتار به همین حساب برسد. */
function AccountForm({ section, onSaved, onCancel, notify }) {
  const [draft, setDraft] = useState({ bankId: '', name: '', openingBalance: '' });
  const [busy, setBusy] = useState(false);
  const isBank = section === 'banks';
  const suggested = isBank && draft.bankId ? `جاری ${bankById(draft.bankId)?.name.replace(/^بانک\s*/, '')}` : '';
  const save = async (event) => {
    event.preventDefault();
    if (isBank && !draft.bankId) { notify('بانک را از فهرست انتخاب کن.'); return; }
    setBusy(true);
    try {
      const item = await api.saveAccount({
        name: (draft.name || suggested || 'صندوق').trim(), kind: isBank ? 'bank' : 'cash', bankId: isBank ? draft.bankId : '',
        openingBalance: Number(digitsOnly(String(draft.openingBalance)) || 0), active: true,
      });
      notify(isBank ? 'بانک تعریف شد.' : 'صندوق تعریف شد.');
      await onSaved(item.item || item);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  return (
    <form onSubmit={save} className="mt-4 space-y-2 rounded-[12px] border border-line bg-surface p-4">
      <p className="text-[13px] font-extrabold">{isBank ? 'تعریف بانک' : 'تعریف صندوق'}</p>
      {isBank && (
        <select required value={draft.bankId} onChange={(event) => setDraft({ ...draft, bankId: event.target.value })} className="tap w-full rounded-lg border border-line bg-paper px-2 text-[13px]">
          <option value="">— بانک را انتخاب کن —</option>
          {BANKS.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}
        </select>
      )}
      <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        placeholder={suggested || (isBank ? 'نام حساب، مثلاً جاری ملت شرکت' : 'نام صندوق، مثلاً صندوق فروشگاه')}
        className="tap w-full rounded-lg border border-line bg-paper px-3 text-[13px]" />
      <label className="block text-xs text-muted">موجودی ابتدای دوره (تومان)
        <input inputMode="numeric" value={draft.openingBalance} onChange={(event) => setDraft({ ...draft, openingBalance: digitsOnly(event.target.value) })}
          placeholder="۰" className="numbers tap mt-1 w-full rounded-lg border border-line bg-paper px-3 text-[13px]" />
      </label>
      <div className="flex gap-2">
        <button disabled={busy} className="tap flex-1 rounded-lg bg-ink px-3 text-[13px] font-bold text-on-fill disabled:opacity-60">ذخیره</button>
        <button type="button" onClick={onCancel} className="tap rounded-lg border border-line px-3 text-[13px] font-bold">انصراف</button>
      </div>
    </form>
  );
}

/** تعریف شخص یا شرکت — بی‌آنکه منتظر اولین فاکتور بمانیم. */
function ContactForm({ onSaved, onCancel, notify }) {
  const [draft, setDraft] = useState({ name: '', kind: 'person', phone: '' });
  const [busy, setBusy] = useState(false);
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const item = await api.saveContact({ name: draft.name.trim(), kind: draft.kind, phone: digitsOnly(draft.phone) });
      notify('طرف حساب تعریف شد.');
      await onSaved(item.item || item);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  return (
    <form onSubmit={save} className="mt-4 space-y-2 rounded-[12px] border border-line bg-surface p-4">
      <p className="text-[13px] font-extrabold">تعریف شخص یا شرکت</p>
      <input required minLength={2} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        placeholder="مثلاً شرکت آفتاب یا آقای کریمی" className="tap w-full rounded-lg border border-line bg-paper px-3 text-[13px]" />
      <div className="grid grid-cols-2 gap-2">
        <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })} className="tap rounded-lg border border-line bg-paper px-2 text-[13px]">
          <option value="person">شخص</option>
          <option value="customer">مشتری</option>
          <option value="vendor">تأمین‌کننده</option>
        </select>
        <input inputMode="tel" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
          placeholder="تلفن (اختیاری)" className="numbers tap rounded-lg border border-line bg-paper px-3 text-[13px]" />
      </div>
      <div className="flex gap-2">
        <button disabled={busy} className="tap flex-1 rounded-lg bg-ink px-3 text-[13px] font-bold text-on-fill disabled:opacity-60">ذخیره</button>
        <button type="button" onClick={onCancel} className="tap rounded-lg border border-line px-3 text-[13px] font-bold">انصراف</button>
      </div>
    </form>
  );
}

function AccountList({ items, empty, onOpen }) {
  if (!items.length) return <p className="mt-6 rounded-[10px] border border-dashed border-line px-4 py-8 text-center text-[13px] leading-7 text-muted">{empty}</p>;
  return (
    <div className="mt-3 divide-y divide-line border-y border-line">
      {items.map((account) => {
        const bank = account.bankId ? bankById(account.bankId) : null;
        const balance = Number(account.balance || 0);
        return (
          <button key={account.id} onClick={() => onOpen(account)} className="tap flex w-full items-center gap-3 py-3 text-right">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-paper text-muted">
              {account.kind === 'bank' ? <Landmark size={18} /> : <Wallet size={18} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-extrabold">{account.name}</span>
              <span className="block text-xs text-muted">
                {account.kind === 'bank' ? (bank?.name || 'بانکش مشخص نیست') : CASH_KINDS[account.kind] || 'حساب'}
                {!account.active ? ' · غیرفعال' : ''}
              </span>
            </span>
            <span className={`numbers shrink-0 text-sm font-extrabold ${balance < 0 ? 'text-expense' : ''}`}>{balance < 0 ? '− ' : ''}{formatAmount(Math.abs(balance))}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AccountCardsPanel({ accounts = [], contacts = [], notify, refresh, initialSection = '' }) {
  const [section, setSection] = useState(initialSection || 'banks');
  // برگ منو («کارت بانک‌ها»، «کارت اشخاص» …) همان بخش را باز می‌کند.
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState(null);
  const banks = useMemo(() => accounts.filter((account) => account.kind === 'bank'), [accounts]);
  const boxes = useMemo(() => accounts.filter((account) => account.kind !== 'bank'), [accounts]);

  useEffect(() => { setAdding(false); setOpened(null); }, [section]);

  if (opened) return <MoneyCard account={opened} onBack={() => setOpened(null)} notify={notify} />;

  return (
    <section className="mt-4">
      <div className="flex gap-2">
        {SECTIONS.map(([id, label, Icon]) => (
          <button key={id} onClick={() => setSection(id)}
            className={`tap flex flex-1 items-center justify-center gap-1 rounded-lg px-2 text-[12px] font-bold ${section === id ? 'bg-ink text-on-fill' : 'border border-line bg-surface text-muted'}`}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {section === 'banks' ? `${toPersianDigits(banks.length)} حساب بانکی` : section === 'cash' ? `${toPersianDigits(boxes.length)} صندوق و تنخواه` : `${toPersianDigits(contacts.length)} طرف حساب`}
        </p>
        {!adding && (
          <button onClick={() => setAdding(true)} className="tap flex items-center gap-1 rounded-lg border border-line bg-surface px-3 text-[12px] font-bold">
            <Plus size={15} /> {section === 'banks' ? 'تعریف بانک' : section === 'cash' ? 'تعریف صندوق' : 'تعریف شخص یا شرکت'}
          </button>
        )}
      </div>

      {adding && section !== 'people' && (
        <AccountForm section={section} notify={notify} onCancel={() => setAdding(false)}
          onSaved={async (item) => { setAdding(false); await refresh?.(); if (item?.id) setOpened(item); }} />
      )}
      {adding && section === 'people' && (
        <ContactForm notify={notify} onCancel={() => setAdding(false)} onSaved={async () => { setAdding(false); await refresh?.(); }} />
      )}

      {section === 'banks' && <AccountList items={banks} onOpen={setOpened} empty="هنوز بانکی تعریف نشده است. با «تعریف بانک» بانک را از فهرست انتخاب کن تا گفتهٔ «از ملت دادم» به همین حساب برسد." />}
      {section === 'cash' && <AccountList items={boxes} onOpen={setOpened} empty="هنوز صندوقی تعریف نشده است." />}
      {section === 'people' && <CounterpartyCardPanel contacts={contacts} notify={notify} />}
    </section>
  );
}

export default AccountCardsPanel;
