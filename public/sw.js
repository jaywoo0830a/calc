// ── Cache names (versioned for easy migration) ──────────────
const CACHE_STATIC  = 'calc-static-v3';
const CACHE_RUNTIME = 'calc-runtime-v3';

// ── Assets to pre-cache on install ──────────────────────────
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

// ── Install: pre-cache critical shell assets ────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      return Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: purge old cache versions ──────────────────────
self.addEventListener('activate', (event) => {
  const validCaches = [CACHE_STATIC, CACHE_RUNTIME];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !validCaches.includes(k)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache strategies by request type ─────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // http(s)만 처리 — blob:/data:/chrome-extension: 등은 Cache API에 저장할 수 없어
  // "Request scheme 'blob' is unsupported" 예외를 내고 fetch까지 깨뜨린다.
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // ── 서버 API(/api)는 캐시하지 않음 — ZIP 삭제 후에도 옛 캐시가 남지 않게 ──
  if (url.pathname.startsWith('/api/')) return;

  // ── Strategy 1: Static assets → Cache-first (immutable hashed files)
  if (
    url.pathname.startsWith('/scanic-ml/') ||
    url.pathname.match(/\.(js|css|woff2?|png|svg|ico|webp|avif|wasm|ort)$/) ||
    url.pathname.startsWith('/assets/')
  ) {
    event.respondWith(cacheFirst(CACHE_STATIC, request));
    return;
  }

  // ── Strategy 2: PDF.js worker & fonts (CDN) → Stale-while-revalidate
  if (
    url.hostname === 'unpkg.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(staleWhileRevalidate(CACHE_RUNTIME, request));
    return;
  }

  // ── Strategy 3: Navigation / HTML → Network-first (always fresh)
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(CACHE_RUNTIME, request));
    return;
  }

  // ── Strategy 4: Everything else → Network-first
  event.respondWith(networkFirst(CACHE_RUNTIME, request));
});

// ── Cache-first strategy ────────────────────────────────────
async function cacheFirst(cacheName, request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone());
      } catch { /* 캐시 실패는 무시 — 네트워크 응답은 그대로 전달 */ }
    }
    return response;
  } catch {
    // Offline fallback for navigation
    if (request.mode === 'navigate') {
      const cachedHtml = await caches.match('/');
      if (cachedHtml) return cachedHtml;
    }
    throw new Error('Offline');
  }
}

// ── Network-first strategy ──────────────────────────────────
async function networkFirst(cacheName, request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone());
      } catch { /* 캐시 실패는 무시 */ }
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Offline fallback for navigation
    if (request.mode === 'navigate') {
      const cachedHtml = await caches.match('/');
      if (cachedHtml) return cachedHtml;
    }
    throw new Error('Offline');
  }
}

// ── Stale-while-revalidate strategy ─────────────────────────
async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(async (response) => {
    if (response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch { /* 캐시 실패는 무시 */ }
    }
    return response;
  }).catch(() => cached);
  return cached || fetchPromise;
}
