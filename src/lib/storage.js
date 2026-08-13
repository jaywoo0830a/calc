// 간단한 IndexedDB wrapper — PDF 어노테이션/북마크 저장
// ⚠️ ZIP 아카이브는 서버 저장으로 이동 — listZips/saveZip/loadZip/deleteZip는
//    아래에서 /api/archives를 호출한다. (모든 기기에서 같은 라이브러리)
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

// ── ZIP 아카이브 — 로컬(IndexedDB) + 클라우드(서버) 하이브리드 ──────────────
// 업로드: 클라우드 먼저, 실패(오프라인)하면 로컬에 저장 → id는 'local_*'
// 목록:   서버 목록 + 로컬 전용 항목 병합 (source: 'server' | 'local' | 'cached')
// 열기:   로컬 캐시 먼저 → 없으면 서버 다운로드 후 로컬 캐시 저장 (오프라인 대비)
// 삭제:   로컬 캐시 + 서버 양쪽에서 삭제

async function archiveRequest(path, options) {
  const res = await fetch('/api/archives' + path, options);
  if (!res.ok) {
    let msg = 'API ' + res.status;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res;
}

// ── 로컬(IndexedDB) ZIP 저장소 — 클라우드 캐시 + 오프라인 업로드용 ──
function zipStore(mode) {
  return openDB().then((db) => db.transaction(STORE_ZIPS, mode).objectStore(STORE_ZIPS));
}
async function localZipList() {
  const store = await zipStore('readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function localZipGet(id) {
  const store = await zipStore('readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function localZipPut(record) {
  const store = await zipStore('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function localZipDelete(id) {
  const store = await zipStore('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * 저장된 ZIP 목록 — 서버(클라우드) + 로컬 병합.
 * - source 'server': 클라우드에 있음
 * - source 'local' : 이 기기에만 있음 (오프라인 업로드/예전 로컬 데이터)
 * - source 'cached': 클라우드 ZIP의 로컬 캐시 (오프라인일 때만 목록에 표시)
 */
export async function listZips() {
  let local = [];
  try { local = await localZipList(); } catch { /* 로컬 저장소 접근 실패는 무시 */ }
  let server = [];
  try { server = await (await archiveRequest('')).json(); } catch { /* 오프라인 — 로컬만 */ }
  const serverIds = new Set(server.map((s) => s.id));
  const merged = [
    ...server.map((s) => ({ ...s, source: 'server' })),
    ...local
      .filter((z) => !serverIds.has(z.id)) // 클라우드에 있는 항목은 서버 목록이 대표
      .map((z) => ({
        id: z.id,
        name: z.name,
        savedAt: z.savedAt,
        size: (z.blob && z.blob.size) || 0,
        source: String(z.id).startsWith('local_') ? 'local' : 'cached',
      })),
  ].sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  return merged;
}

/** ZIP 업로드 — 클라우드 먼저. 네트워크 장애(오프라인)만 로컬 폴백,
 *  서버가 거부(용량 초과 등)하면 에러를 던져 알린다. (반환: id) */
export async function saveZip(name, blob) {
  const fd = new FormData();
  fd.append('file', blob, name);
  let res;
  try {
    res = await fetch('/api/archives', { method: 'POST', body: fd });
  } catch {
    // 오프라인/네트워크 장애 → 로컬에만 저장
    const id = 'local_' + Date.now();
    try { await localZipPut({ id, name, blob, savedAt: new Date().toISOString() }); } catch {}
    return id;
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  // 클라우드 성공 — 이 기기에서 바로 열 수 있게 로컬 캐시에도 저장 (best-effort)
  try { await localZipPut({ id: data.id, name, blob, savedAt: data.savedAt }); } catch {}
  return data.id;
}

/** ZIP 불러오기 — 로컬 캐시 먼저, 없으면 서버 다운로드 후 캐시 (없으면 null).
 *  onProgress(loadedBytes, totalBytes) — 스트리밍 다운로드 진행률
 *  (total은 Content-Length, 알 수 없으면 0 — 이 경우 로드량으로만 표시) */
export async function loadZip(id, onProgress) {
  let local = null;
  try { local = await localZipGet(id); } catch {}
  if (local) return { id, name: local.name, blob: local.blob };
  const res = await fetch('/api/archives/' + encodeURIComponent(id));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('API ' + res.status);
  const name = decodeURIComponent(res.headers.get('X-Archive-Name') || '');
  const total = Number(res.headers.get('Content-Length')) || 0;

  let blob;
  if (res.body && typeof onProgress === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    blob = new Blob(chunks, { type: res.headers.get('Content-Type') || '' });
  } else {
    blob = await res.blob();
    if (typeof onProgress === 'function') onProgress(blob.size, total);
  }
  try { await localZipPut({ id, name, blob, savedAt: new Date().toISOString() }); } catch {}
  return { id, name, blob };
}

/** ZIP 삭제 — 로컬 캐시 + 서버 양쪽 (로컬 전용 id는 로컬만) */
export async function deleteZip(id) {
  try { await localZipDelete(id); } catch {}
  if (!String(id).startsWith('local_')) {
    try { await archiveRequest('/' + encodeURIComponent(id), { method: 'DELETE' }); } catch { /* 서버 삭제 실패는 무시 */ }
  }
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
