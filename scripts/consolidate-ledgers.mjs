/**
 * جمع کردن دفترها به دو دفتر: «اصلی» و «ازمایشی».
 *
 *   BASE_URL=https://… HY_USER=… HY_PASS=… BACKUP_PASSPHRASE=… node scripts/consolidate-ledgers.mjs
 *       فقط گزارش: هر دفتر، تعداد ثبت و سند، و اینکه چه می‌شود
 *   … node scripts/consolidate-ledgers.mjs --apply
 *       پشتیبان رمزشدهٔ هر دفترِ کنارگذاشته را در backups/ledgers/ ذخیره و سپس بایگانی‌اش می‌کند
 *
 * KEEP (پیش‌فرض «اصلی,ازمایشی») نام دفترهایی است که می‌مانند. RENAME با شکل
 * «نام قدیم=نام تازه» پیش از هر کاری نام یک دفتر را عوض می‌کند (مثلاً دفتر
 * اصلی فعلی که نام دیگری دارد).
 *
 * بایگانی حذف نیست: داده روی سرور دست نمی‌خورد و از تنظیمات قابل بازگرداندن
 * است. پشتیبان محلی هم برای وقتی است که سرور از دست برود.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const base = String(process.env.BASE_URL || '').replace(/\/$/, '');
const apply = process.argv.includes('--apply');
const keep = String(process.env.KEEP || 'اصلی,ازمایشی').split(',').map((name) => name.trim()).filter(Boolean);
const passphrase = String(process.env.BACKUP_PASSPHRASE || '');
if (!/^https?:\/\//.test(base) || !process.env.HY_USER || !process.env.HY_PASS) throw new Error('BASE_URL، HY_USER و HY_PASS لازم است.');
if (apply && passphrase.length < 12) throw new Error('برای --apply عبارت BACKUP_PASSPHRASE (حداقل ۱۲ نویسه) لازم است؛ پشتیبان بدون آن ساخته نمی‌شود.');

let cookie = '';
let csrf = '';
async function call(method, path, { body, workspace, raw = false } = {}) {
  const response = await fetch(base + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...(workspace ? { 'x-workspace-id': workspace } : {}) },
  });
  for (const value of response.headers.getSetCookie?.() || []) {
    const [pair] = value.split(';');
    const [name] = pair.split('=');
    cookie = [...cookie.split('; ').filter((item) => item && !item.startsWith(`${name}=`)), pair].join('; ');
  }
  if (raw) {
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${data.code || ''} ${data.message || ''}`);
  return data;
}

const login = await call('POST', '/api/auth/login', { body: { username: process.env.HY_USER, password: process.env.HY_PASS } });
csrf = login.csrfToken;

// در حالت گزارش، نام تازه فقط در محاسبه می‌نشیند و به سرور نمی‌رود.
const planned = new Map();
for (const pair of String(process.env.RENAME || '').split(';').map((item) => item.trim()).filter(Boolean)) {
  const [from, to] = pair.split('=').map((item) => item.trim());
  const target = login.workspaces.find((item) => item.name.trim() === from);
  if (!target) throw new Error(`دفتر «${from}» برای تغییر نام پیدا نشد.`);
  console.log(`${apply ? 'تغییر نام' : '[گزارش] تغییر نام'}: «${from}» ← «${to}»`);
  if (apply) await call('PUT', `/api/workspaces/${target.id}`, { body: { name: to } });
  planned.set(target.id, to);
}

const workspaces = (await call('GET', '/api/workspaces')).workspaces.map((item) => ({ ...item, name: planned.get(item.id) || item.name }));
const rows = [];
for (const workspace of workspaces) {
  const counts = await Promise.all([
    call('GET', '/api/transactions?limit=1', { workspace: workspace.id }).then((r) => r.total ?? r.items?.length ?? '?').catch(() => '?'),
    call('GET', '/api/invoices', { workspace: workspace.id }).then((r) => r.items?.length ?? '?').catch(() => '?'),
  ]);
  const kept = keep.includes(workspace.name.trim());
  rows.push({ name: workspace.name, role: workspace.role, transactions: counts[0], invoices: counts[1], action: kept ? 'می‌ماند' : workspace.role !== 'owner' ? 'دست نمی‌خورد (مالک نیستی)' : 'بایگانی' });
}
console.table(rows);
const missing = keep.filter((name) => !workspaces.some((item) => item.name.trim() === name));
if (missing.length) {
  console.log(`دفترهای نگه‌داشتنی پیدا نشدند: ${missing.join('، ')}. با RENAME نامشان را درست کن؛ تا آن وقت چیزی بایگانی نمی‌شود.`);
  process.exit(apply ? 1 : 0);
}
if (!apply) { console.log('فقط گزارش بود. برای اجرا --apply را اضافه کن.'); process.exit(0); }

await mkdir('backups/ledgers', { recursive: true, mode: 0o700 });
for (const workspace of workspaces) {
  if (keep.includes(workspace.name.trim()) || workspace.role !== 'owner') continue;
  const backup = await call('POST', '/api/backups/export', { body: { passphrase }, workspace: workspace.id, raw: true });
  const file = `backups/ledgers/${workspace.id}-${new Date().toISOString().slice(0, 10)}.hybackup`;
  await writeFile(file, backup, { mode: 0o600 });
  const result = await call('POST', `/api/workspaces/${workspace.id}/archive`, { workspace: workspaces.find((item) => keep.includes(item.name.trim()))?.id });
  console.log(`بایگانی شد: ${workspace.name} — پشتیبان محلی ${file}${result.backup ? `، پشتیبان سرور ${result.backup.fileName}` : ''}`);
}
console.log('دفترهای فعال:', (await call('GET', '/api/workspaces')).workspaces.map((item) => item.name).join('، '));
