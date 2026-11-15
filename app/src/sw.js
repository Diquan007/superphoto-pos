// Service worker van de webversie: maakt de kassa installeerbaar als app en laat de
// schermen ook zonder internet openen. Altijd eerst het netwerk (dus meteen de nieuwste
// versie); alleen als dat niet lukt de opgeslagen kopie. Database-verkeer gaat er niet doorheen.
const CACHE = 'sp-kassa-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await caches.match('./index.html') || await caches.match('./'); if (idx) return idx; }
      throw new Error('offline');
    }
  })());
});
