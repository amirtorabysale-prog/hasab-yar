import { randomUUID } from 'node:crypto';
import { db, invalidInput } from './core.js';

export function getLearnings() {
  return db.prepare('SELECT id,keyword,category,created_at AS createdAt,updated_at AS updatedAt FROM learnings ORDER BY updated_at DESC').all();
}

export function saveLearning({ id = randomUUID(), keyword, category }) {
  const cleanedKeyword = String(keyword || '').trim().slice(0, 80);
  const cleanedCategory = String(category || '').trim().slice(0, 80);
  if (cleanedKeyword.length < 2 || !cleanedCategory) throw invalidInput('عبارت و دسته را کامل وارد کن.');
  db.prepare(`INSERT INTO learnings (id,keyword,category) VALUES (?,?,?)
    ON CONFLICT(keyword) DO UPDATE SET category=excluded.category,updated_at=CURRENT_TIMESTAMP`).run(id, cleanedKeyword, cleanedCategory);
  return db.prepare('SELECT id,keyword,category FROM learnings WHERE keyword=?').get(cleanedKeyword);
}

export function updateLearning(id, values) {
  const current = db.prepare('SELECT * FROM learnings WHERE id=?').get(id);
  if (!current) return null;
  db.prepare('UPDATE learnings SET keyword=?,category=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(values.keyword || current.keyword).trim().slice(0, 80), String(values.category || current.category).trim().slice(0, 80), id);
  return db.prepare('SELECT id,keyword,category FROM learnings WHERE id=?').get(id);
}

export function deleteLearning(id) { return db.prepare('DELETE FROM learnings WHERE id=?').run(id).changes > 0; }
