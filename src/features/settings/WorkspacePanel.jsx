import { useCallback, useEffect, useState } from 'react';
import { Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api.js';
import { toPersianDigits } from '../../lib/format.js';

const ROLE_LABELS = { owner: 'مالک', manager: 'مدیر', accountant: 'حسابدار', viewer: 'فقط مشاهده' };

export default function WorkspacePanel({ access, notify, switchWorkspace, refreshAccess }) {
  const [members, setMembers] = useState([]);
  const [workspaceDraft, setWorkspaceDraft] = useState({ name: '', profileType: 'business' });
  const [memberDraft, setMemberDraft] = useState({ username: '', displayName: '', temporaryPassword: '', role: 'viewer' });
  const role = access.workspace?.role || 'viewer';
  const canViewMembers = ['owner', 'manager'].includes(role);
  const isOwner = role === 'owner';
  const professional = access.experience === 'professional';
  const [switching, setSwitching] = useState(false);
  // فقط مالک محیطش را انتخاب می‌کند؛ حسابدار و مدیر همیشه حرفه‌ای‌اند.
  const switchExperience = async () => {
    setSwitching(true);
    try {
      await api.setExperience(professional ? 'simple' : 'professional');
      await refreshAccess();
      notify(professional ? 'محیط ساده فعال شد.' : 'محیط حرفه‌ای فعال شد؛ ابزار حسابدار در منو آمد.');
    } catch (error) { notify(error.message); }
    setSwitching(false);
  };
  const loadMembers = useCallback(() => canViewMembers ? api.members().then((result) => setMembers(result.items)).catch((error) => notify(error.message)) : Promise.resolve(), [canViewMembers, notify]);
  useEffect(() => { loadMembers(); }, [loadMembers, access.workspace?.id]);
  const create = async (event) => {
    event.preventDefault();
    try {
      const result = await api.createWorkspace(workspaceDraft);
      setWorkspaceDraft({ name: '', profileType: 'business' });
      await switchWorkspace(result.workspace.id);
      notify('دفتر تازه و پایگاه‌دادهٔ جدا ساخته شد.');
    } catch (error) { notify(error.message); }
  };
  const [archived, setArchived] = useState([]);
  const loadArchived = useCallback(() => api.archivedWorkspaces().then((result) => setArchived(result.items)).catch(() => setArchived([])), []);
  useEffect(() => { loadArchived(); }, [loadArchived]);
  const owned = access.workspaces.filter((workspace) => workspace.role === 'owner');
  const rename = async (workspace) => {
    const name = window.prompt('نام تازهٔ دفتر:', workspace.name);
    if (!name?.trim() || name.trim() === workspace.name) return;
    try { await api.renameWorkspace(workspace.id, name.trim()); await refreshAccess(); notify('نام دفتر عوض شد.'); }
    catch (error) { notify(error.message); }
  };
  // بایگانی حذف نیست: دفتر از فهرست بیرون می‌رود، داده‌اش دست‌نخورده می‌ماند و برمی‌گردد.
  const archive = async (workspace) => {
    if (!window.confirm(`دفتر «${workspace.name}» بایگانی شود؟\n\nاز فهرست و از دسترسی همه بیرون می‌رود، ولی داده‌اش پاک نمی‌شود و از همین‌جا قابل بازگرداندن است.`)) return;
    try {
      const result = await api.archiveWorkspace(workspace.id);
      if (workspace.id === access.workspace?.id && result.workspace?.id) await switchWorkspace(result.workspace.id);
      await refreshAccess(); await loadArchived();
      notify(result.backup ? `دفتر بایگانی شد؛ پشتیبان رمزشده ${result.backup.fileName} ساخته شد.` : 'دفتر بایگانی شد؛ داده‌اش روی سرور دست‌نخورده ماند.');
    } catch (error) { notify(error.message); }
  };
  const restore = async (workspace) => {
    try { await api.restoreWorkspace(workspace.id); await refreshAccess(); await loadArchived(); notify(`دفتر «${workspace.name}» برگشت.`); }
    catch (error) { notify(error.message); }
  };
  const add = async (event) => {
    event.preventDefault();
    try {
      await api.addMember(memberDraft);
      setMemberDraft({ username: '', displayName: '', temporaryPassword: '', role: 'viewer' });
      await loadMembers();
      notify('دسترسی عضو ذخیره شد.');
    } catch (error) { notify(error.message); }
  };
  const updateRole = async (userId, nextRole) => {
    try { await api.updateMember(userId, nextRole); await loadMembers(); notify('نقش عضو تغییر کرد.'); }
    catch (error) { notify(error.message); }
  };
  const remove = async (userId) => {
    if (!window.confirm('دسترسی این عضو از دفتر حذف شود؟')) return;
    try { await api.removeMember(userId); await loadMembers(); await refreshAccess(); notify('دسترسی عضو حذف شد.'); }
    catch (error) { notify(error.message); }
  };
  return <section className="mx-auto mt-1 max-w-[760px] px-4"><div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-start gap-3"><Users className="mt-0.5 shrink-0 text-accent" size={22} /><div><h2 className="font-extrabold">دفترها و دسترسی تیم</h2><p className="mt-1 text-[13px] leading-6 text-muted">اطلاعات هر دفتر در پایگاه‌داده‌ای جدا نگه‌داری می‌شود. نقش فعلی تو: <b className="text-ink">{ROLE_LABELS[role]}</b></p></div></div>{isOwner && <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper px-3 py-3"><div className="min-w-0"><p className="text-[13px] font-bold">{professional ? 'محیط حرفه‌ای' : 'محیط ساده'}</p><p className="mt-0.5 text-xs leading-5 text-muted">{professional ? 'صف بررسی، سند، کدینگ و خروجی پارسیان در منو هستند.' : 'فقط ثبت روزانه و گزارش دیده می‌شود. خروجی پارسیان و ابزار حسابدار در محیط حرفه‌ای است.'}</p></div><button type="button" disabled={switching} onClick={switchExperience} className="tap shrink-0 rounded-lg border border-accent px-3 text-[12px] font-bold text-accent disabled:opacity-40">{switching ? 'در حال تغییر…' : professional ? 'رفتن به محیط ساده' : 'رفتن به محیط حرفه‌ای'}</button></div>}<label className="mt-4 block text-[13px] text-muted">دفتر فعال<select value={access.workspace?.id || ''} onChange={(event) => switchWorkspace(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 font-bold text-ink">{access.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} — {ROLE_LABELS[workspace.role]}</option>)}</select></label>{owned.length > 0 && <div className="mt-4 border-t border-line pt-4"><h3 className="text-[13px] font-extrabold">مدیریت دفترها</h3><div className="mt-2 divide-y divide-line">{owned.map((workspace) => <div key={workspace.id} className="flex min-h-[52px] items-center gap-2 py-2"><p className="min-w-0 flex-1 truncate text-sm font-bold">{workspace.name}{workspace.id === access.workspace?.id && <span className="mr-1 text-xs font-normal text-muted">(فعال)</span>}</p><button type="button" onClick={() => rename(workspace)} className="tap rounded-lg border border-line px-3 text-[12px] font-bold">تغییر نام</button>{access.workspaces.length > 1 && <button type="button" onClick={() => archive(workspace)} className="tap rounded-lg border border-expense/50 px-3 text-[12px] font-bold text-expense">بایگانی</button>}</div>)}</div>{archived.length > 0 && <div className="mt-3"><p className="text-[12px] text-muted">بایگانی‌شده</p>{archived.map((workspace) => <div key={workspace.id} className="flex min-h-[44px] items-center gap-2"><p className="min-w-0 flex-1 truncate text-[13px] text-muted">{workspace.name}</p><button type="button" onClick={() => restore(workspace)} className="tap rounded-lg border border-accent px-3 text-[12px] font-bold text-accent">بازگرداندن</button></div>)}</div>}</div>}<form onSubmit={create} className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[1fr_150px_120px]"><input required minLength={2} value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })} placeholder="نام دفتر تازه" className="tap rounded-lg border border-line px-3" /><select value={workspaceDraft.profileType} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, profileType: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="business">کسب‌وکار</option><option value="personal">شخصی</option></select><button className="tap rounded-lg bg-ink px-3 text-sm font-bold text-on-fill">ساخت دفتر</button></form>{canViewMembers && <div className="mt-5 border-t border-line pt-4"><div className="flex items-center justify-between"><h3 className="font-extrabold">اعضای این دفتر</h3><span className="text-xs text-muted">{toPersianDigits(members.length)} نفر</span></div><div className="mt-3 divide-y divide-line border-y border-line">{members.map((member) => <div key={member.id} className="flex min-h-[68px] items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{member.displayName || member.username}</p><p className="mt-1 truncate text-xs text-muted" dir="ltr">@{member.username}</p></div>{isOwner ? <select value={member.role} onChange={(event) => updateRole(member.id, event.target.value)} className="tap max-w-32 rounded-lg border border-line bg-surface px-2 text-xs font-bold"><option value="owner">مالک</option><option value="manager">مدیر</option><option value="accountant">حسابدار</option><option value="viewer">فقط مشاهده</option></select> : <span className="rounded-md border border-line px-2 py-1 text-xs">{ROLE_LABELS[member.role]}</span>}{isOwner && member.id !== access.user?.id && <button onClick={() => remove(member.id)} className="tap grid place-items-center text-expense" aria-label="حذف دسترسی"><Trash2 size={17} /></button>}</div>)}</div>{isOwner && <form onSubmit={add} className="mt-4 grid gap-2 sm:grid-cols-2"><input required value={memberDraft.username} onChange={(event) => setMemberDraft({ ...memberDraft, username: event.target.value })} placeholder="نام کاربری انگلیسی" dir="ltr" className="tap rounded-lg border border-line px-3 text-left" /><input value={memberDraft.displayName} onChange={(event) => setMemberDraft({ ...memberDraft, displayName: event.target.value })} placeholder="نام نمایشی" className="tap rounded-lg border border-line px-3" /><input value={memberDraft.temporaryPassword} onChange={(event) => setMemberDraft({ ...memberDraft, temporaryPassword: event.target.value })} placeholder="رمز موقت ۱۴ نویسه‌ای (برای کاربر تازه)" dir="ltr" type="password" autoComplete="new-password" className="tap rounded-lg border border-line px-3 text-left" /><select value={memberDraft.role} onChange={(event) => setMemberDraft({ ...memberDraft, role: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="viewer">فقط مشاهده</option><option value="accountant">حسابدار</option><option value="manager">مدیر</option><option value="owner">مالک</option></select><button className="tap rounded-lg bg-accent font-bold text-on-fill sm:col-span-2">افزودن یا به‌روزرسانی عضو</button></form>}<p className="mt-3 text-xs leading-5 text-muted">کاربر تازه در اولین ورود باید رمز موقت را عوض کند. حسابدار ثبت‌های مالی را مدیریت می‌کند؛ مدیر تنظیمات دفتر را هم تغییر می‌دهد؛ فقط مالک اعضا را مدیریت می‌کند.</p></div>}</div></section>;
}

