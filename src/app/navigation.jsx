import { useEffect, useMemo, useState } from 'react';
import { BarChart3, BookOpenCheck, ChevronDown, ChevronLeft, FolderTree, HandCoins, Home, Landmark, LayoutGrid, PiggyBank, ReceiptText, Search, Settings, Users, WalletCards, X } from 'lucide-react';
import { findMenuItem, searchMenu, visibleMenu } from './menu.js';
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

const GROUP_ICONS = { ...SCREEN_ICONS, receipt: ReceiptText, tree: FolderTree };

const OPEN_GROUPS_KEY = 'hesab-yar-menu-open';
const readOpenGroups = () => { try { return JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) || 'null'); } catch { return null; } };

/**
 * منوی درختی: گروه‌ها باز و بسته می‌شوند و هر برگ مستقیم همان زبانه را باز
 * می‌کند. گروهِ صفحهٔ فعلی همیشه باز است تا کاربر بداند کجاست. با جست‌وجو، همهٔ
 * برگ‌های پیدا‌شده یک‌جا نشان داده می‌شوند و Enter اولی را باز می‌کند.
 */
export function MenuTree({ access, screen, section = '', navigate, profileType = 'business', searchRef = null }) {
  const groups = useMemo(() => visibleMenu(allowedScreens(access), { ledgerTabs: profileDefinition(profileType).ledgerTabs }), [access, profileType]);
  const current = findMenuItem(groups, screen, section);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set(readOpenGroups() || groups.map((group) => group.id)));
  useEffect(() => { if (current) setOpen((previous) => (previous.has(current.group.id) ? previous : new Set([...previous, current.group.id]))); }, [current?.group.id]);
  const toggle = (id) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...next])); } catch { /* فقط راحتی کاربر است */ }
    return next;
  });
  const results = query.trim() ? searchMenu(groups, query) : null;
  const go = (item) => { setQuery(''); navigate(item.screen, item.section || ''); };
  const isCurrent = (item) => current?.item === item;
  const leaf = (item) => <button key={item.label} type="button" aria-current={isCurrent(item) ? 'page' : undefined} onClick={() => go(item)} className="menu-leaf"><span>{item.label}</span></button>;

  return <nav aria-label="منوی حساب‌یار" className="workspace-navigation">
    <label className="menu-search"><Search size={16} aria-hidden="true" /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && results?.[0]) go(results[0].item); if (event.key === 'Escape') setQuery(''); }}
      placeholder="جست‌وجوی بخش‌ها (Ctrl+K)" aria-label="جست‌وجوی بخش‌ها" /></label>
    {results ? <div className="menu-results" role="list">
      {results.length ? results.map(({ group, item }) => <button type="button" role="listitem" key={`${group.id}-${item.label}`} onClick={() => go(item)} className="menu-leaf menu-result"><span>{item.label}</span><small>{group.label}</small></button>)
        : <p className="menu-empty">بخشی با این نام پیدا نشد.</p>}
    </div> : groups.map((group) => {
      const Icon = GROUP_ICONS[group.icon] || Home;
      const expanded = open.has(group.id);
      const active = current?.group.id === group.id;
      return <div className="nav-group" key={group.id}>
        <button type="button" className={`menu-group${active ? ' is-active' : ''}`} aria-expanded={expanded} onClick={() => toggle(group.id)}>
          <Icon size={18} aria-hidden="true" /><span>{group.label}</span><ChevronDown size={16} aria-hidden="true" className={`menu-chevron${expanded ? ' is-open' : ''}`} />
        </button>
        {expanded && <div className="menu-leaves">{group.items.map(leaf)}</div>}
      </div>;
    })}
  </nav>;
}

export function DesktopNav({ screen, section = '', navigate, businessName, profileType = 'business', access, searchRef = null }) {
  const profile = profileDefinition(profileType);
  return <aside className="desktop-nav hidden lg:block"><div className="desktop-nav-inner"><div className="workspace-brand"><span className="brand-mark"><BookOpenCheck size={24} /></span><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="text-xs text-muted">فضای کار مالی شما</p></div></div><div className="workspace-identity"><span className="text-xs text-muted">دفتر فعال</span><p className="mt-1 break-words text-sm font-bold">{access?.workspace?.name || businessName || profile.label}</p></div><MenuTree access={access} screen={screen} section={section} navigate={navigate} profileType={profileType} searchRef={searchRef} /></div></aside>;
}

export function BottomNav({ screen, navigate, access }) {
  // فقط صفحه‌های اصلی در نوار پایین جا می‌شوند؛ بقیه در کشو می‌مانند.
  const items = allowedScreens(access).filter((item) => item.primary).sort((a, b) => (a.id === 'review' ? -1 : b.id === 'review' ? 1 : 0)).slice(0, 4).sort((a, b) => (a.id === 'today' ? -1 : b.id === 'today' ? 1 : 0))
    .map((item) => ({ id: item.id, label: item.label, icon: SCREEN_ICONS[item.icon] || Home }));
  return <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex h-[76px] max-w-[640px] items-start justify-around border-t border-line bg-surface px-3 pb-[env(safe-area-inset-bottom)] pt-2 lg:hidden">{items.map((item) => { const Icon = item.icon; const active = screen === item.id; return <button key={item.id} aria-current={active ? 'page' : undefined} onClick={() => navigate(item.id)} className={`tap flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-bold ${active ? 'text-accent' : 'text-muted'}`}><Icon size={21} strokeWidth={active ? 2.6 : 2} />{item.label}</button>; })}</nav>;
}

export function Drawer({ profileType = 'business', close, navigate, access, screen, section = '' }) {
  const profile = profileDefinition(profileType);
  return <div className="fixed inset-0 z-[60] bg-scrim/35 lg:hidden" onKeyDown={(event) => { if (event.key === 'Escape') close(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <aside aria-label="منوی بخش‌ها" className="sheet-in h-full w-[86%] max-w-[340px] overflow-y-auto bg-surface px-4 py-5 shadow-2xl">
      <div className="flex items-center justify-between"><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="mt-1 text-xs text-muted">{access?.workspace?.name || profile.label}</p></div><button autoFocus onClick={close} className="tap grid place-items-center" aria-label="بستن منو"><X /></button></div>
      <MenuTree access={access} screen={screen} section={section} profileType={profileType} navigate={(id, part) => { navigate(id, part); close(); }} />
    </aside>
  </div>;
}
