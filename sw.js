// Service worker SANS cache : l'app est toujours chargée depuis le réseau (jamais de copie locale),
// donc chaque mise à jour est prise en compte à l'ouverture suivante. Il sert uniquement à rendre l'app installable.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k); // purge des anciens caches
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return; // le reste passe tel quel
  // Paramètre unique : contourne aussi le cache du CDN de GitHub Pages (en plus du cache du navigateur).
  const u = new URL(r.url); u.searchParams.set('_', Date.now());
  e.respondWith(fetch(new Request(u.href, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' })));
});
