/* Watchdog: runs on its own thread. The page checks in twice a second while a game runs.
   If the check-ins stop while the app is visible, the page (and the emulator's main thread) is
   frozen; this records for how long, in IndexedDB, so it survives a reload. If the whole page is
   killed for memory instead, this thread dies with it and records nothing past the last check-in. */
let last = Date.now(), hidden = false, frozenSince = 0, game = '';
let db = null;

function open() {
  return db || (db = new Promise((res) => {
    try {
      const r = indexedDB.open('phostation', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  }));
}
async function save(rec) {
  const d = await open();
  if (!d) return;
  try { d.transaction('kv', 'readwrite').objectStore('kv').put(rec, 'watchdog'); } catch (e) {}
}

onmessage = (e) => {
  const m = e.data || {};
  if (m.start) { game = m.game || ''; last = Date.now(); frozenSince = 0; save({ game, startedAt: last, lastSeen: last, longestFreeze: 0, frozen: false }); }
  if (m.stop) { game = ''; frozenSince = 0; }
  if (m.hidden != null) { hidden = m.hidden; last = Date.now(); }
  if (m.ping) {
    const now = Date.now();
    if (frozenSince) {
      // The page came back after a freeze.
      save({ game, lastSeen: now, frozen: false, recoveredAfter: now - frozenSince, longestFreeze: Math.max(now - frozenSince, 0) });
      frozenSince = 0;
    }
    last = now;
  }
};

let tick = 0;
setInterval(() => {
  if (hidden || !game) return;
  const gap = Date.now() - last;
  if (gap > 2500) {
    if (!frozenSince) frozenSince = last;
    save({ game, lastSeen: last, frozen: true, frozenFor: gap, at: Date.now() });
  } else if (++tick % 10 === 0) {
    save({ game, lastSeen: last, frozen: false, at: Date.now() }); // occasional "still fine" note
  }
}, 1000);
