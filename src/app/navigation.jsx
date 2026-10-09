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

const NAV_GROUPS = [
  { label: 'کارهای روزانه', ids: ['today', 'ledger', 'petty-cash'] },
  { label: 'حسابداری و گزارش', ids: ['review', 'accounting', 'report', 'tax'] },
  { label: 'مدیریت دفتر', ids: ['firm', 'chart', 'collaboration', 'learning', 'settings'] },
];

function GroupedNavigation({ access, screen, navigate }) {
  const screens = allowedScreens(access);
  const known = new Set(NAV_GROUPS.flatMap((group) => group.ids));
  const groups = [...NAV_GROUPS, { label: 'سایر بخش‌ها', ids: screens.filter((item) => !known.has(item.id)).map((item) => item.id) }];
  return <nav aria-label="بخش‌های حساب‌یار" className="workspace-navigation">{groups.map((group) => {
    const items = group.ids.map((id) => screens.find((item) => item.id === id)).filter(Boolean);
    if (!items.length) return null;
    return <div className="nav-group" key={group.label}><p className="nav-group-label">{group.label}</p>{items.map((item) => {
      const Icon = SCREEN_ICONS[item.icon] || Home;
      return <button type="button" key={item.id} aria-current={screen === item.id ? 'page' : undefined} onClick={() => navigate(item.id)} className="workspace-nav-item"><Icon size={19} aria-hidden="true" /><span>{item.label}</span>{screen === item.id && <span className="nav-active-dot" aria-hidden="true" />}</button>;
    })}</div>;
  })}</nav>;
}

export function DesktopNav({ screen, navigate, businessName, profileType = 'business', access }) {
  const profile = profileDefinition(profileType);
  return <aside className="desktop-nav hidden lg:block"><div className="desktop-nav-inner"><div className="workspace-brand"><span className="brand-mark"><BookOpenCheck size={24} /></span><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="text-xs text-muted">فضای کار مالی شما</p></div></div><div className="workspace-identity"><span className="text-[11px] text-muted">دفتر فعال</span><p className="mt-1 break-words text-sm font-bold">{access?.workspace?.name || businessName || profile.label}</p></div><GroupedNavigation access={access} screen={screen} navigate={navigate} /></div></aside>;
}

export function InsightRail({ overview = {}, navigate, open = false, setOpen }) {
  return <aside className={`insight-rail hidden border-r border-line bg-paper xl:block ${open ? 'px-5 py-7' : 'px-2 py-5'}`}><div className="sticky top-5"><button onClick={() => setOpen(!open)} className={`tap flex items-center rounded-lg border border-line bg-surface text-xs font-extrabold ${open ? 'w-full justify-between px-3' : 'mx-auto w-12 justify-center'}`} aria-expanded={open} aria-label={open ? 'جمع‌کردن وضعیت نقدینگی' : 'بازکردن وضعیت نقدینگی'}>{open && <span>وضعیت نقدینگی</span>}<ChevronLeft size={19} className={`transition-transform ${open ? 'rotate-180' : ''}`} /></button>{open ? <div className="mt-5 space-y-5"><div><p className="text-[13px] text-muted">وضعیت همین حالا</p><p className="numbers mt-2 text-2xl font-extrabold">{formatAmount(overview.cash || 0)}</p><p className="text-xs leading-5 text-muted">تومان ماندهٔ برآوردی ثبت‌ها</p></div><div className="border-y border-line py-4 text-sm"><div className="flex justify-between py-1"><span className="text-muted">طلب باز</span><b className="numbers text-income">{formatAmount(overview.receivable || 0)}</b></div><div className="flex justify-between py-1"><span className="text-muted">بدهی باز</span><b className="numbers text-expense">{formatAmount(overview.payable || 0)}</b></div>{overview.runwayDays != null && <div className="flex justify-between py-1"><span className="text-muted">دوام نقدینگی</span><b>{toPersianDigits(overview.runwayDays)} روز</b></div>}</div><p className="text-[11px] leading-5 text-muted">این مانده تا پیش از تطبیق صندوق یا بانک، قطعی نیست.</p><button onClick={() => navigate('ledger')} className="tap w-full rounded-lg border border-line bg-surface px-3 text-sm font-bold">بازکردن دفتر کامل</button></div> : <button onClick={() => setOpen(true)} className="insight-rail-label mx-auto mt-5 flex min-h-[150px] items-center text-[11px] font-extrabold text-muted">نبض نقدینگی</button>}</div></aside>;
}

export function BottomNav({ screen, navigate, access }) {
  // فقط صفحه‌های اصلی در نوار پایین جا می‌شوند؛ بقیه در کشو می‌مانند.
  const items = allowedScreens(access).filter((item) => item.primary).sort((a, b) => (a.id === 'review' ? -1 : b.id === 'review' ? 1 : 0)).slice(0, 4).sort((a, b) => (a.id === 'today' ? -1 : b.id === 'today' ? 1 : 0))
    .map((item) => ({ id: item.id, label: item.label, icon: SCREEN_ICONS[item.icon] || Home }));
  return <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex h-[76px] max-w-[640px] items-start justify-around border-t border-line bg-surface px-3 pb-[env(safe-area-inset-bottom)] pt-2 lg:hidden">{items.map((item) => { const Icon = item.icon; const active = screen === item.id; return <button key={item.id} aria-current={active ? 'page' : undefined} onClick={() => navigate(item.id)} className={`tap flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-bold ${active ? 'text-accent' : 'text-muted'}`}><Icon size={21} strokeWidth={active ? 2.6 : 2} />{item.label}</button>; })}</nav>;
}

export function Drawer({ profileType = 'business', close, navigate, access, screen }) {
  const profile = profileDefinition(profileType);
  return <div className="fixed inset-0 z-[60] bg-ink/35 lg:hidden" onKeyDown={(event) => { if (event.key === 'Escape') close(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <aside aria-label="منوی بخش‌ها" className="sheet-in h-full w-[86%] max-w-[340px] overflow-y-auto bg-surface px-4 py-5 shadow-2xl">
      <div className="flex items-center justify-between"><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="mt-1 text-xs text-muted">{access?.workspace?.name || profile.label}</p></div><button autoFocus onClick={close} className="tap grid place-items-center" aria-label="بستن منو"><X /></button></div>
      <GroupedNavigation access={access} screen={screen} navigate={(id) => { navigate(id); close(); }} />
    </aside>
  </div>;
}
