// Service worker : met l'app en cache pour qu'elle marche hors ligne.
// Ne met JAMAIS en cache les requêtes vers d'autres domaines (miniatures, worker…).
const CACHE = 'safe-bookmarks-v1.0.1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'crypto.js', 'media.js', 'sync.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Réseau d'abord (mises à jour), cache en secours ; la page partagée (?url=…) sert index.html.
  e.respondWith((async () => {
    const isNav = e.request.mode === 'navigate';
    const key = isNav ? new Request(new URL('./', location).href) : e.request;
    try {
      const res = await fetch(isNav ? key : e.request);
      if (res.ok) (await caches.open(CACHE)).put(key, res.clone());
      return res;
    } catch {
      return (await caches.match(key, { ignoreSearch: true })) || Response.error();
    }
  })());
});
