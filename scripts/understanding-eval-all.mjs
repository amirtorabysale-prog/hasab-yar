#!/usr/bin/env node
/**
 * اجرای هر سه ارزیابی فهم رویداد پشت سر هم — برای سرویس آزمایشی، نه سایت اصلی.
 *
 * روی محیط آزمایشی Railway کنار خود سرور اجرا می‌شود (فرمان شروع:
 * `sh -c 'node scripts/understanding-eval-all.mjs & exec node server/index.js'`).
 * هر ارزیابی دیتابیس موقت خودش را دارد و به دیتابیس همان سرویس دست نمی‌زند.
 *
 * نتیجه‌ها در `UNDERSTANDING_EVAL_OUT` نوشته می‌شوند — پوشه‌ای زیر `dist/` با نام
 * تصادفی، تا بدون ورود به برنامه از همان دامنهٔ آزمایشی خوانده شوند. محتوایشان
 * فقط جمله‌های ساختگی آزمون و نتیجهٔ ارزیابی است. `status.json` پیشرفت را می‌گوید.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.UNDERSTANDING_EVAL_OUT || '';
if (!/^dist\/eval-[a-z0-9]{16,}$/.test(out)) {
  console.log('understanding-eval-all: UNDERSTANDING_EVAL_OUT تنظیم نشده یا نامعتبر است؛ ارزیابی اجرا نشد.');
  process.exit(0);
}
const directory = join(root, out);
mkdirSync(directory, { recursive: true });

const steps = [
  { name: 'acceptance', args: ['--provider=openai'] },
  { name: 'stress40', args: ['--provider=openai', '--set=stress40'] },
  { name: 'v3', args: ['--provider=openai', '--set=v3'] },
];
const status = { startedAt: new Date().toISOString(), release: process.env.RAILWAY_GIT_COMMIT_SHA || null, steps: {} };
const save = () => writeFileSync(join(directory, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
save();

for (const step of steps) {
  status.steps[step.name] = { state: 'running', startedAt: new Date().toISOString() };
  save();
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(root, 'scripts/understanding-eval.mjs'), ...step.args, `--out=${join(directory, step.name)}`], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', done);
  });
  status.steps[step.name] = { ...status.steps[step.name], state: code === 0 ? 'done' : 'failed', exitCode: code, finishedAt: new Date().toISOString() };
  save();
}
status.finishedAt = new Date().toISOString();
save();
console.log('understanding-eval-all: پایان', JSON.stringify(status.steps));
