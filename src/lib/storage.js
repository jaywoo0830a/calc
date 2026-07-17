// 간단한 IndexedDB wrapper — ZIP 파일 blob 영구 저장
const DB_NAME = 'calc-viewer';
const DB_VERSION = 1;
const STORE = 'zips';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 저장된 ZIP 목록 조회 */
export async function listZips() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** ZIP blob 저장 (id 자동생성: filename_timestamp) */
export async function saveZip(name, blob) {
  const db = await openDB();
  const id = `${name}_${Date.now()}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.add({ id, name, blob, savedAt: new Date().toISOString() });
    req.onsuccess = () => resolve(id);
    req.onerror = () => reject(req.error);
  });
}

/** 저장된 ZIP 하나 불러오기 */
export async function loadZip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** 저장된 ZIP 삭제 */
export async function deleteZip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
