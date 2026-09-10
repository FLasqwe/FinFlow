/* FinFlow service worker.
   Стратегии:
   - навигация            → network-first, оффлайн-фолбэк на закэшированный index.html
   - статика (иконки и т.п.) → cache-first + фоновое обновление
   - Google Fonts          → stale-while-revalidate
   - GET /api/* (кроме auth/health) → network-first, оффлайн-фолбэк на кэш
   - POST/PUT/PATCH/DELETE, /api/auth/*, /api/health → network-only (не кэшируем)
   Версия в имени кэшей — при её смене старые кэши удаляются на activate. */

const VERSION = 'v1';
const SHELL_CACHE = `ff-shell-${VERSION}`;
const FONT_CACHE = `ff-fonts-${VERSION}`;
const API_CACHE = `ff-api-${VERSION}`;
const KEEP = [SHELL_CACHE, FONT_CACHE, API_CACHE];

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
    // skipWaiting не вызываем: новая версия ждёт, пока пользователь нажмёт «Обновить».
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_API_CACHE') caches.delete(API_CACHE);
});

const isFont = (url) =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // мутации — только в сеть, мимо SW

  const url = new URL(request.url);

  // Навигация: network-first, оффлайн → index.html из кэша
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html', { ignoreSearch: true }))
    );
    return;
  }

  // Google Fonts: stale-while-revalidate
  if (isFont(url)) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await network) || fetch(request);
      })
    );
    return;
  }

  // Только наш origin ниже
  if (url.origin !== self.location.origin) return;

  // API
  if (url.pathname.startsWith('/api/')) {
    const cacheable =
      !url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/health';
    if (!cacheable) return; // network-only
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res && res.ok) {
            const cache = await caches.open(API_CACHE);
            cache.put(request, res.clone());
          }
          return res;
        } catch (err) {
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response(
            JSON.stringify({ error: 'offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
      })()
    );
    return;
  }

  // Прочая статика нашего origin: cache-first + фоновое обновление
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })
  );
});
