import {
  belongsToOfflineScope, normalizeOfflineScope, normalizeOfflineState, requireOfflineScope,
} from './offlineScope.js';

const DB_NAME = 'hesab-yar-offline';
const STORE = 'audio';
const DB_VERSION = 2;

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE)
        ? request.transaction.objectStore(STORE)
        : database.createObjectStore(STORE, { keyPath: 'id' });
      // نسخهٔ قبلی مالک و دفتر نداشت. نسبت‌دادن آن صداها به کاربر فعلی ناامن است،
      // پس فقط هنگام مهاجرت حذف می‌شوند و هرگز زیر نشست دیگری ارسال نمی‌شوند.
      if (event.oldVersion > 0 && event.oldVersion < DB_VERSION) {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          if (!normalizeOfflineScope(cursor.value)) cursor.delete();
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function updateRecord(id, scopeValue, updater) {
  const scope = requireOfflineScope(scopeValue);
  const database = await openDb();
  const transaction = database.transaction(STORE, 'readwrite');
  const store = transaction.objectStore(STORE);
  const request = store.get(String(id || ''));
  const changed = await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const record = request.result;
      if (!record || !belongsToOfflineScope(record, scope)) { resolve(false); return; }
      const next = updater(record);
      if (next) store.put(next);
      else store.delete(record.id);
      resolve(true);
    };
    request.onerror = () => reject(request.error);
  });
  await transactionDone(transaction);
  database.close();
  return changed;
}

export async function saveOfflineAudio(blob, scopeValue) {
  const scope = requireOfflineScope(scopeValue);
  if (!(blob instanceof Blob) || blob.size <= 0) {
    throw Object.assign(new Error('فایل صوتی آفلاین معتبر نیست.'), { code: 'OFFLINE_AUDIO_INVALID' });
  }
  const database = await openDb();
  const transaction = database.transaction(STORE, 'readwrite');
  const item = {
    id: crypto.randomUUID(),
    blob,
    ...scope,
    state: 'queued',
    attempts: 0,
    lastError: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  transaction.objectStore(STORE).put(item);
  await transactionDone(transaction);
  database.close();
  return item;
}

export async function pendingAudio(scopeValue) {
  const scope = requireOfflineScope(scopeValue);
  const database = await openDb();
  const request = database.transaction(STORE).objectStore(STORE).getAll();
  const records = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return records
    .filter((item) => belongsToOfflineScope(item, scope) && ['queued', 'review'].includes(normalizeOfflineState(item.state)))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

export async function countOfflineAudio(scopeValue) {
  const scope = requireOfflineScope(scopeValue);
  const database = await openDb();
  const request = database.transaction(STORE).objectStore(STORE).getAll();
  const records = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return records.filter((item) => belongsToOfflineScope(item, scope) && ['queued', 'review'].includes(normalizeOfflineState(item.state))).length;
}

export function markOfflineAudioForReview(id, scopeValue) {
  return updateRecord(id, scopeValue, (record) => ({
    ...record,
    state: 'review',
    attempts: Number(record.attempts || 0) + 1,
    lastError: '',
    updatedAt: new Date().toISOString(),
  }));
}

export function releaseOfflineAudio(id, scopeValue, error = '') {
  return updateRecord(id, scopeValue, (record) => ({
    ...record,
    state: 'queued',
    lastError: String(error || '').slice(0, 300),
    updatedAt: new Date().toISOString(),
  }));
}

export function removeOfflineAudio(id, scopeValue) {
  return updateRecord(id, scopeValue, () => null);
}
