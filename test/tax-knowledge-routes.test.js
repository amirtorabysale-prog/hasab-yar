import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * مسیرهای منابع نسخه‌دار مالیاتی از راه HTTP.
 *
 * از commit «فاز ۱ هوش مالیاتی» این نه مسیر توابعی را صدا می‌زدند که در فایل
 * مسیر import نشده بودند؛ هر درخواست به هرکدام ReferenceError و پاسخ ۵۰۰ می‌گرفت.
 * آزمون‌های هسته همان توابع را مستقیم صدا می‌زدند و این را نمی‌دیدند. این آزمون
 * همهٔ نه مسیر را از خود سرور عبور می‌دهد.
 */

const databasePath = tempDatabase('tax-knowledge-routes');
const username = 'tax-routes-owner';
const password = randomBytes(24).toString('base64url');
test.after(() => removeTempDatabase(databasePath));

test('همهٔ مسیرهای /api/tax-knowledge جواب می‌دهند و چرخهٔ ثبت، انتشار و رد کار می‌کند', async () => {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', NODE_ENV: 'test', DATABASE_PATH: databasePath, ADMIN_USERNAME: username, ADMIN_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`سرور بالا نیامد: ${output}`)), 15_000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/listening on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.stderr.on('data', (chunk) => { output += chunk; });
    });
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const session = await login.json();
    const headers = { cookie, 'x-csrf-token': session.csrfToken, 'x-workspace-id': session.workspace?.id || 'primary', 'content-type': 'application/json' };
    const call = async (method, path, body) => {
      const response = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };

    const empty = await call('GET', '/api/tax-knowledge/documents');
    assert.equal(empty.status, 200, JSON.stringify(empty.data));
    assert.ok(Array.isArray(empty.data.items));
    assert.equal((await call('GET', '/api/tax-knowledge/documents/ناموجود')).status, 404);
    assert.equal((await call('GET', '/api/tax-knowledge/versions/ناموجود')).status, 404);
    assert.equal((await call('POST', '/api/tax-knowledge/versions/ناموجود/publish')).status, 404);

    const draftValues = {
      documentClass: 'circular', authorityTier: 4, issuer: 'سازمان امور مالیاتی', effectiveFrom: '2026-01-01',
      officialUrl: 'https://intamedia.ir/routes', rawText: 'ماده 1 - متن اول.\nتبصره 1 - استثنا.',
    };
    const draft = await call('POST', '/api/tax-knowledge/documents', { ...draftValues, title: 'بخشنامهٔ آزمون مسیر', versionLabel: 'v1' });
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    assert.equal(draft.data.item.verified, false);
    const versionId = draft.data.item.id;
    const documentId = draft.data.item.documentId;

    const version = await call('GET', `/api/tax-knowledge/versions/${versionId}`);
    assert.equal(version.status, 200);
    assert.equal(version.data.item.provisions.length, 2);
    assert.equal((await call('GET', `/api/tax-knowledge/documents/${documentId}`)).status, 200);
    const queue = await call('GET', '/api/tax-knowledge/review-queue');
    assert.equal(queue.status, 200);
    assert.ok(queue.data.items.some((item) => item.id === versionId));
    // پیش از انتشار قابل استناد نیست.
    const before = await call('GET', '/api/tax-knowledge/citable?asOf=2026-06-01');
    assert.equal(before.status, 200);
    assert.ok(!before.data.items.some((item) => item.id === versionId));

    const published = await call('POST', `/api/tax-knowledge/versions/${versionId}/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal(published.data.item.verified, true);
    const after = await call('GET', '/api/tax-knowledge/citable?asOf=2026-06-01');
    assert.ok(after.data.items.some((item) => item.id === versionId));

    // رد بی‌دلیل خطای اعتبارسنجی است، نه ۵۰۰؛ با دلیل، نسخهٔ منتشرنشده کنار می‌رود.
    const second = await call('POST', '/api/tax-knowledge/documents', { ...draftValues, title: 'بخشنامهٔ ردشدنی', versionLabel: 'v1' });
    assert.equal(second.status, 201);
    assert.equal((await call('POST', `/api/tax-knowledge/versions/${second.data.item.id}/reject`)).status, 400);
    const rejected = await call('POST', `/api/tax-knowledge/versions/${second.data.item.id}/reject`, { reason: 'متن با منبع رسمی نمی‌خواند' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
    assert.equal(rejected.data.item.status, 'withdrawn');

    const relation = await call('POST', '/api/tax-knowledge/relations', { sourceVersionId: versionId, targetVersionId: versionId, relation: 'annuls' });
    assert.equal(relation.status, 400, JSON.stringify(relation.data));
    assert.equal(relation.data.code, 'TAX_RELATION_INVALID');
  } finally { child.kill(); }
});
