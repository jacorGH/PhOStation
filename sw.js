/* PhoStation service worker: network-first for the app shell so updates show up right away,
   cached copy when offline. EmulatorJS and libraries come from their CDNs and are not cached here. */
const CACHE = 'phostation-v8';
const SHELL = ['./', 'index.html', 'emu.html', 'css/app.css', 'js/boot.js', 'js/ice.js', 'js/mesh.js', 'js/emu.js', 'js/library.js', 'js/shrink.js', 'js/unpack.js', 'js/spill.js', 'js/disk-worker.js', 'js/pbp-worker.js', 'js/controls.js', 'js/delta.js', 'js/direct.js', 'js/nettest.js', 'js/net.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
