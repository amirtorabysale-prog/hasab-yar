import { randomUUID } from 'node:crypto';
import { db, invalidInput } from './core.js';
import { forgetAiLesson } from './aiLessons.js';

/** یادگیری‌هایی که سیستم خودش ساخته: از ثبت‌های AI و از تأییدِ حسابدار در صف. */
const LEARNED_SOURCES = new Set(['ai', 'accountant']);

export function getLearnings() {
  return db.prepare('SELECT id,keyword,category,source,created_at AS createdAt,updated_at AS updatedAt FROM learnings ORDER BY updated_at DESC').all();
}

// نگاشتی که کاربر خودش می‌سازد یا عوض می‌کند، مالِ خودش است ('manual')؛ حتی اگر
// پیش‌تر از AI یاد گرفته شده بود.
export function saveLearning({ id = randomUUID(), keyword, category }) {
  const cleanedKeyword = String(keyword || '').trim().slice(0, 80);
  const cleanedCategory = String(category || '').trim().slice(0, 80);
  if (cleanedKeyword.length < 2 || !cleanedCategory) throw invalidInput('عبارت و دسته را کامل وارد کن.');
  const previous = db.prepare('SELECT id,category,source FROM learnings WHERE keyword=?').get(cleanedKeyword);
  db.prepare(`INSERT INTO learnings (id,keyword,category,source) VALUES (?,?,?,'manual')
    ON CONFLICT(keyword) DO UPDATE SET category=excluded.category,source='manual',updated_at=CURRENT_TIMESTAMP`).run(id, cleanedKeyword, cleanedCategory);
  if (LEARNED_SOURCES.has(previous?.source) && previous.category !== cleanedCategory) forgetAiLesson(previous.id);
  return db.prepare('SELECT id,keyword,category,source FROM learnings WHERE keyword=?').get(cleanedKeyword);
}

export function updateLearning(id, values) {
  const current = db.prepare('SELECT * FROM learnings WHERE id=?').get(id);
  if (!current) return null;
  const keyword = String(values.keyword || current.keyword).trim().slice(0, 80);
  const category = String(values.category || current.category).trim().slice(0, 80);
  const changed = keyword !== current.keyword || category !== current.category;
  db.prepare('UPDATE learnings SET keyword=?,category=?,source=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(keyword, category, changed ? 'manual' : current.source, id);
  // یادگیریِ AI که کاربر اصلاحش کرد، درسِ غلطی بود؛ دوباره خودکار برنمی‌گردد.
  if (changed && LEARNED_SOURCES.has(current.source)) forgetAiLesson(id);
  return db.prepare('SELECT id,keyword,category,source FROM learnings WHERE id=?').get(id);
}

export function deleteLearning(id) {
  const current = db.prepare('SELECT source FROM learnings WHERE id=?').get(id);
  const removed = db.prepare('DELETE FROM learnings WHERE id=?').run(id).changes > 0;
  if (removed && LEARNED_SOURCES.has(current?.source)) forgetAiLesson(id);
  return removed;
}
