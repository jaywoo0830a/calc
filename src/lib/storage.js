// 간단한 IndexedDB wrapper — ZIP 파일 blob + annotations 영구 저장
const DB_NAME = 'calc-viewer';
const DB_VERSION = 3;
const STORE_ZIPS = 'zips';
const STORE_ANNOTATIONS = 'annotations';
const STORE_BOOKMARKS = 'bookmarks';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ZIPS)) {
        db.createObjectStore(STORE_ZIPS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_ANNOTATIONS)) {
        const store = db.createObjectStore(STORE_ANNOTATIONS, { keyPath: 'id' });
        store.createIndex('filePath', 'filePath', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BOOKMARKS)) {
        const store = db.createObjectStore(STORE_BOOKMARKS, { keyPath: 'id' });
        store.createIndex('filePath', 'filePath', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 저장된 ZIP 목록 조회 */
export async function listZips() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ZIPS, 'readonly');
    const req = tx.objectStore(STORE_ZIPS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** ZIP blob 저장 (id 자동생성: filename_timestamp) */
export async function saveZip(name, blob) {
  const db = await openDB();
  const id = `${name}_${Date.now()}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ZIPS, 'readwrite');
    const store = tx.objectStore(STORE_ZIPS);
    const req = store.add({ id, name, blob, savedAt: new Date().toISOString() });
    req.onsuccess = () => resolve(id);
    req.onerror = () => reject(req.error);
  });
}

/** 저장된 ZIP 하나 불러오기 */
export async function loadZip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ZIPS, 'readonly');
    const req = tx.objectStore(STORE_ZIPS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** 저장된 ZIP 삭제 */
export async function deleteZip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ZIPS, 'readwrite');
    const req = tx.objectStore(STORE_ZIPS).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ============================================================
// PDF Annotations CRUD
// ============================================================

/** 특정 파일의 모든 어노테이션 조회 */
export async function getAnnotations(filePath) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ANNOTATIONS, 'readonly');
    const idx = tx.objectStore(STORE_ANNOTATIONS).index('filePath');
    const req = idx.getAll(filePath);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** 어노테이션 저장 (id 있으면 update, 없으면 insert) */
export async function saveAnnotation(annotation) {
  const db = await openDB();
  const record = {
    ...annotation,
    id: annotation.id || `${annotation.filePath}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    updatedAt: new Date().toISOString(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ANNOTATIONS, 'readwrite');
    const store = tx.objectStore(STORE_ANNOTATIONS);
    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

/** 어노테이션 삭제 */
export async function deleteAnnotation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ANNOTATIONS, 'readwrite');
    const req = tx.objectStore(STORE_ANNOTATIONS).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** 특정 파일의 모든 어노테이션 삭제 */
export async function deleteAllAnnotations(filePath) {
  const db = await openDB();
  const all = await getAnnotations(filePath);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ANNOTATIONS, 'readwrite');
    const store = tx.objectStore(STORE_ANNOTATIONS);
    for (const a of all) store.delete(a.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// PDF Bookmarks CRUD
// ============================================================

/** 특정 파일의 모든 북마크 조회 */
export async function getBookmarks(filePath) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKMARKS, 'readonly');
    const idx = tx.objectStore(STORE_BOOKMARKS).index('filePath');
    const req = idx.getAll(filePath);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** 북마크 저장 */
export async function saveBookmark(bookmark) {
  const db = await openDB();
  const record = {
    ...bookmark,
    id: bookmark.id || `${bookmark.filePath}_${bookmark.pageNumber}`,
    createdAt: bookmark.createdAt || new Date().toISOString(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
    const store = tx.objectStore(STORE_BOOKMARKS);
    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

/** 북마크 삭제 */
export async function deleteBookmark(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
    const req = tx.objectStore(STORE_BOOKMARKS).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
