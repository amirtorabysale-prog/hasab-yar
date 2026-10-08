import { BarChart3, BookOpenCheck, ChevronLeft, HandCoins, Home, Landmark, LayoutGrid, PiggyBank, ReceiptText, Settings, Users, WalletCards, X } from 'lucide-react';
import { formatAmount, toPersianDigits } from '../lib/format.js';
import { profileDefinition } from '../../shared/product.js';

/**
 * آیکن هر صفحه.
 *
 * فهرست صفحه‌ها از سرور می‌آید تا فرانت‌اند نسخهٔ موازی نسازد؛ همان قاعده‌ای
 * که دروازهٔ سرور با آن کار می‌کند. فقط آیکن اینجا می‌ماند، چون داده نیست.
 */
const SCREEN_ICONS = {
  home: Home, wallet: WalletCards, chart: BarChart3, settings: Settings,
  grid: LayoutGrid, inbox: ReceiptText, book: BookOpenCheck, landmark: Landmark,
  coins: HandCoins, users: Users, petty: PiggyBank,
};

/** صفحه‌های مجاز این کاربر؛ تا وقتی دسترسی نرسیده، ناوبری خالی می‌ماند نه حدسی. */
export function allowedScreens(access) {
  return Array.isArray(access?.screens) ? access.screens : [];
}

export function DesktopNav({ screen, navigate, businessName, profileType = 'business', access }) {
  // میز کار فقط وقتی معنا دارد که کاربر بیش از یک پرونده داشته باشد.
  const items = allowedScreens(access).map((item) => [item.id, item.label, SCREEN_ICONS[item.icon] || Home]);
  const profile = profileDefinition(profileType);
  return <aside className="desktop-nav hidden border-l border-line bg-surface px-4 py-6 lg:block"><div className="sticky top-6"><div className="mb-8 border-b border-line pb-5"><p className="text-xl font-extrabold">حساب‌یار</p><p className="mt-1 truncate text-xs text-muted">{businessName || profile.label}</p><p className="mt-1 text-[11px] leading-5 text-muted">دستیار ثبت و مدیریت نقدینگی</p></div><nav className="space-y-1">{items.map(([id, label, Icon]) => <button key={id} onClick={() => navigate(id)} className={`tap flex w-full items-center gap-3 rounded-lg px-3 text-right text-sm font-bold ${screen === id ? 'bg-warn-bg text-accent' : 'text-muted hover:bg-paper hover:text-ink'}`}><Icon size={20} />{label}</button>)}</nav></div></aside>;
}

export function InsightRail({ overview = {}, navigate, open = false, setOpen }) {
  return <aside className={`insight-rail hidden border-r border-line bg-paper xl:block ${open ? 'px-5 py-7' : 'px-2 py-5'}`}><div className="sticky top-5"><button onClick={() => setOpen(!open)} className={`tap flex items-center rounded-lg border border-line bg-surface text-xs font-extrabold ${open ? 'w-full justify-between px-3' : 'mx-auto w-12 justify-center'}`} aria-expanded={open} aria-label={open ? 'جمع‌کردن وضعیت نقدینگی' : 'بازکردن وضعیت نقدینگی'}>{open && <span>وضعیت نقدینگی</span>}<ChevronLeft size={19} className={`transition-transform ${open ? 'rotate-180' : ''}`} /></button>{open ? <div className="mt-5 space-y-5"><div><p className="text-[13px] text-muted">وضعیت همین حالا</p><p className="numbers mt-2 text-2xl font-extrabold">{formatAmount(overview.cash || 0)}</p><p className="text-xs leading-5 text-muted">تومان ماندهٔ برآوردی ثبت‌ها</p></div><div className="border-y border-line py-4 text-sm"><div className="flex justify-between py-1"><span className="text-muted">طلب باز</span><b className="numbers text-income">{formatAmount(overview.receivable || 0)}</b></div><div className="flex justify-between py-1"><span className="text-muted">بدهی باز</span><b className="numbers text-expense">{formatAmount(overview.payable || 0)}</b></div>{overview.runwayDays != null && <div className="flex justify-between py-1"><span className="text-muted">دوام نقدینگی</span><b>{toPersianDigits(overview.runwayDays)} روز</b></div>}</div><p className="text-[11px] leading-5 text-muted">این مانده تا پیش از تطبیق صندوق یا بانک، قطعی نیست.</p><button onClick={() => navigate('ledger')} className="tap w-full rounded-lg border border-line bg-surface px-3 text-sm font-bold">بازکردن دفتر کامل</button></div> : <button onClick={() => setOpen(true)} className="insight-rail-label mx-auto mt-5 flex min-h-[150px] items-center text-[11px] font-extrabold text-muted">نبض نقدینگی</button>}</div></aside>;
}

export function BottomNav({ screen, navigate, access }) {
  // فقط صفحه‌های اصلی در نوار پایین جا می‌شوند؛ بقیه در کشو می‌مانند.
  const items = allowedScreens(access).filter((item) => item.primary).slice(0, 4)
    .map((item) => ({ id: item.id, label: item.label, icon: SCREEN_ICONS[item.icon] || Home }));
  return <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex h-[76px] max-w-[640px] items-start justify-around border-t border-line bg-surface px-3 pb-[env(safe-area-inset-bottom)] pt-2 lg:hidden">{items.map((item) => { const Icon = item.icon; const active = screen === item.id; return <button key={item.id} onClick={() => navigate(item.id)} className={`tap flex min-w-20 flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-bold ${active ? 'text-accent' : 'text-muted'}`}><Icon size={21} strokeWidth={active ? 2.6 : 2} />{item.label}</button>; })}</nav>;
}

export function Drawer({ profileType = 'business', close, navigate, access }) {
  const profile = profileDefinition(profileType);
  return <div className="fixed inset-0 z-[60] bg-ink/35 lg:hidden" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <aside className="sheet-in h-full w-[82%] max-w-[330px] bg-paper px-4 py-5 shadow-2xl">
      <div className="flex items-center justify-between"><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="text-xs text-muted">{profile.label} · دستیار نقدینگی</p></div><button onClick={close} className="tap grid place-items-center" aria-label="بستن"><X /></button></div>
      <div className="mt-8 space-y-2">
        {/* همان فهرستی که سرور اجازه داده؛ کشو نسخهٔ دوم نمی‌سازد. */}
        {allowedScreens(access).map((item) => {
          const Icon = SCREEN_ICONS[item.icon] || Home;
          return <DrawerItem key={item.id} icon={Icon} label={item.label} onClick={() => navigate(item.id)} />;
        })}
      </div>
      <div className="absolute bottom-6 right-4 left-4 border-t border-line pt-4 text-xs leading-6 text-muted">هیچ مبلغی بدون تأیید تو ثبت نمی‌شود.</div>
    </aside>
  </div>;
}

function DrawerItem({ icon: Icon, label, onClick }) { return <button onClick={onClick} className="tap flex w-full items-center gap-3 rounded-lg px-3 text-right font-bold hover:bg-surface"><Icon size={20} className="text-muted" />{label}</button>; }
