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
  return <section className="mx-auto mt-1 max-w-[760px] px-4"><div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-start gap-3"><Users className="mt-0.5 shrink-0 text-accent" size={22} /><div><h2 className="font-extrabold">دفترها و دسترسی تیم</h2><p className="mt-1 text-[13px] leading-6 text-muted">اطلاعات هر دفتر در پایگاه‌داده‌ای جدا نگه‌داری می‌شود. نقش فعلی تو: <b className="text-ink">{ROLE_LABELS[role]}</b></p></div></div><label className="mt-4 block text-[13px] text-muted">دفتر فعال<select value={access.workspace?.id || ''} onChange={(event) => switchWorkspace(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 font-bold text-ink">{access.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} — {ROLE_LABELS[workspace.role]}</option>)}</select></label><form onSubmit={create} className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[1fr_150px_120px]"><input required minLength={2} value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })} placeholder="نام دفتر تازه" className="tap rounded-lg border border-line px-3" /><select value={workspaceDraft.profileType} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, profileType: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="business">کسب‌وکار</option><option value="personal">شخصی</option></select><button className="tap rounded-lg bg-ink px-3 text-sm font-bold text-white">ساخت دفتر</button></form>{canViewMembers && <div className="mt-5 border-t border-line pt-4"><div className="flex items-center justify-between"><h3 className="font-extrabold">اعضای این دفتر</h3><span className="text-xs text-muted">{toPersianDigits(members.length)} نفر</span></div><div className="mt-3 divide-y divide-line border-y border-line">{members.map((member) => <div key={member.id} className="flex min-h-[68px] items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{member.displayName || member.username}</p><p className="mt-1 truncate text-xs text-muted" dir="ltr">@{member.username}</p></div>{isOwner ? <select value={member.role} onChange={(event) => updateRole(member.id, event.target.value)} className="tap max-w-32 rounded-lg border border-line bg-surface px-2 text-xs font-bold"><option value="owner">مالک</option><option value="manager">مدیر</option><option value="accountant">حسابدار</option><option value="viewer">فقط مشاهده</option></select> : <span className="rounded-md border border-line px-2 py-1 text-xs">{ROLE_LABELS[member.role]}</span>}{isOwner && member.id !== access.user?.id && <button onClick={() => remove(member.id)} className="tap grid place-items-center text-expense" aria-label="حذف دسترسی"><Trash2 size={17} /></button>}</div>)}</div>{isOwner && <form onSubmit={add} className="mt-4 grid gap-2 sm:grid-cols-2"><input required value={memberDraft.username} onChange={(event) => setMemberDraft({ ...memberDraft, username: event.target.value })} placeholder="نام کاربری انگلیسی" dir="ltr" className="tap rounded-lg border border-line px-3 text-left" /><input value={memberDraft.displayName} onChange={(event) => setMemberDraft({ ...memberDraft, displayName: event.target.value })} placeholder="نام نمایشی" className="tap rounded-lg border border-line px-3" /><input value={memberDraft.temporaryPassword} onChange={(event) => setMemberDraft({ ...memberDraft, temporaryPassword: event.target.value })} placeholder="رمز موقت ۱۴ نویسه‌ای (برای کاربر تازه)" dir="ltr" type="password" autoComplete="new-password" className="tap rounded-lg border border-line px-3 text-left" /><select value={memberDraft.role} onChange={(event) => setMemberDraft({ ...memberDraft, role: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="viewer">فقط مشاهده</option><option value="accountant">حسابدار</option><option value="manager">مدیر</option><option value="owner">مالک</option></select><button className="tap rounded-lg bg-accent font-bold text-white sm:col-span-2">افزودن یا به‌روزرسانی عضو</button></form>}<p className="mt-3 text-[11px] leading-5 text-muted">کاربر تازه در اولین ورود باید رمز موقت را عوض کند. حسابدار ثبت‌های مالی را مدیریت می‌کند؛ مدیر تنظیمات دفتر را هم تغییر می‌دهد؛ فقط مالک اعضا را مدیریت می‌کند.</p></div>}</div></section>;
}

