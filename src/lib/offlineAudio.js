const DB_NAME = 'hesab-yar-offline';
const STORE = 'audio';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveOfflineAudio(blob) {
  const db = await openDb();
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).put({ id: crypto.randomUUID(), blob, createdAt: new Date().toISOString() });
  return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
}

export async function pendingAudio() {
  const db = await openDb();
  const request = db.transaction(STORE).objectStore(STORE).getAll();
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function removeOfflineAudio(id) {
  const db = await openDb();
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).delete(id);
  return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
}
