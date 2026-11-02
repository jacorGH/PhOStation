/* PhoStation service worker.
   1) Network-first for the app shell so updates show up right away; cached copy when offline.
   2) Cross-origin isolation (needed by the PSP emulator's threads). GitHub Pages can't send the
      headers, so they're added here:
      - normal mode: COEP "credentialless" (Chrome, Edge, Firefox). Other sites' files load as-is.
      - experimental iPhone mode: COEP "require-corp", which Safari supports. Files from other
        sites must then be explicitly shareable, so they're re-requested here with CORS and
        marked shareable (CORP: cross-origin).
   The mode is stored in IndexedDB ('phostation' > kv > coiMode) because workers can't read localStorage. */
const CACHE = 'phostation-v11';
const SHELL = ['./', 'index.html', 'emu.html', 'css/app.css', 'js/boot.js', 'js/ice.js', 'js/mesh.js', 'js/emu.js', 'js/system.js', 'js/psplab.js',
  'js/library.js', 'js/shrink.js', 'js/unpack.js', 'js/spill.js', 'js/disk-worker.js', 'js/pbp-worker.js', 'js/controls.js',
  'js/delta.js', 'js/direct.js', 'js/nettest.js', 'js/net.js', 'js/app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

let coiMode = null;
function readMode() {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('phostation', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        try {
          const q = r.result.transaction('kv').objectStore('kv').get('coiMode');
          q.onsuccess = () => res(q.result === 'require-corp' ? 'require-corp' : 'credentialless');
          q.onerror = () => res('credentialless');
        } catch (e) { res('credentialless'); }
      };
      r.onerror = () => res('credentialless');
    } catch (e) { res('credentialless'); }
  });
}
const modeReady = readMode().then((m) => (coiMode = m));
self.addEventListener('message', (e) => { if (e.data && e.data.coiMode) coiMode = e.data.coiMode; });

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function isolate(res, mode) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', mode);
  h.set('Cross-Origin-Resource-Policy', mode === 'require-corp' ? 'cross-origin' : 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// require-corp: fetch other sites' files with CORS and mark them shareable.
async function shareable(req) {
  try {
    const r = await fetch(req.url, { mode: 'cors', credentials: 'omit', cache: req.cache === 'only-if-cached' ? 'default' : req.cache });
    const h = new Headers(r.headers);
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  } catch (e) {
    return fetch(req); // the site doesn't allow CORS; the browser will decide
  }
}

async function sameOrigin(req) {
  const mode = coiMode || (await modeReady);
  try {
    const res = await fetch(req);
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return isolate(res, mode);
  } catch (e) {
    return isolate(await caches.match(req, { ignoreSearch: true }), mode);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) { e.respondWith(sameOrigin(req)); return; }
  if (!/^https?:$/.test(url.protocol)) return;
  if (coiMode === 'credentialless') return; // normal mode: leave other sites alone
  e.respondWith((coiMode ? Promise.resolve(coiMode) : modeReady).then((m) => (m === 'require-corp' ? shareable(req) : fetch(req))));
});
