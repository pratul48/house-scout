// Caches the app itself so it opens instantly. Live data (maps, places) always comes from the network.
const CACHE = 'house-scout-v5';
const SHELL = ['./', 'index.html', 'style.css', 'db.js', 'geo.js', 'ohio.js', 'roof.js', 'daycare.js', 'value.js', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  const isShell = url.startsWith(self.location.origin) || url.startsWith('https://unpkg.com/leaflet@1.9.4/');
  if (!isShell) return; // let API/tile requests go straight to the network
  // network-first so updates show up, cache as offline fallback
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
