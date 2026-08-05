// ============================================================================
// URUOI 水分管理 — Service Worker
// ファイルを更新したら CACHE_NAME を必ず上げること。
// 上げないと古いキャッシュが配られて、変更が端末に届かない。
// 新しいファイルを足したら ASSETS にも追加する。
// ============================================================================
const CACHE_NAME = 'uruoi-v1';
const ASSETS = [
  './',
  './index.html',
  './sync.js',
  './manifest.json',
  './icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // 同期（Supabase）の通信には一切触らない。
  // キャッシュを挟むと古い応答を掴んで、同期が壊れたように見えることがある。
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        return response;
      }).catch(() => cached);
    })
  );
});
