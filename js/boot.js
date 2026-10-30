/* PhoStation boot — must load BEFORE EmulatorJS.
   1) Forces preserveDrawingBuffer so canvas.captureStream() never sends black frames.
   2) Taps every Web Audio graph that reaches the speakers so game audio can be streamed.
   3) Tiny prefs + IndexedDB helpers shared by the other modules. */
(function () {
  const PS = (window.PS = window.PS || {});

  // ---------- 1. WebGL capture fix ----------
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    }
    return origGetContext.call(this, type, attrs);
  };

  // ---------- 1b. Render the emulator at PS1 resolution ----------
  // Libraries size their canvas by devicePixelRatio; on a 3x iPhone that means 9x the pixels
  // to draw, copy and stream for a 320x240 picture. The page's own text and images are unaffected.
  try {
    const realDpr = window.devicePixelRatio || 1;
    PS.realDpr = realDpr;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 1 });
  } catch (e) {}

  // ---------- 2. Game-audio tap ----------
  PS.audio = { contexts: new Set(), taps: new Map() };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const ret = origConnect.call(this, dest, ...rest);
    try {
      if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode) {
        const ctx = this.context;
        PS.audio.contexts.add(ctx);
        let tap = PS.audio.taps.get(ctx);
        if (!tap) {
          tap = ctx.createMediaStreamDestination();
          PS.audio.taps.set(ctx, tap);
        }
        origConnect.call(this, tap);
      }
    } catch (e) { /* never break the emulator's audio */ }
    return ret;
  };
  const resumeAudio = () =>
    PS.audio.contexts.forEach((c) => c.state === 'suspended' && c.resume().catch(() => {}));
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) =>
    addEventListener(ev, resumeAudio, { capture: true, passive: true })
  );

  // ---------- 3a. Prefs (localStorage) ----------
  let p = {};
  try { p = JSON.parse(localStorage.getItem('phostation.prefs') || '{}'); } catch (e) {}
  const save = () => { try { localStorage.setItem('phostation.prefs', JSON.stringify(p)); } catch (e) {} };
  if (p.haptics === undefined) p.haptics = true;
  PS.prefs = new Proxy(p, { set(t, k, v) { t[k] = v; save(); return true; } });

  // A per-tab identity: survives reloads/reconnects, distinct per tab.
  let cid = null;
  try { cid = sessionStorage.getItem('phostation.cid'); } catch (e) {}
  if (!cid) {
    cid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { sessionStorage.setItem('phostation.cid', cid); } catch (e) {}
  }
  PS.clientId = cid;

  // ---------- 3b. IndexedDB key/value ----------
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('phostation', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const q = fn(d.transaction('kv', mode).objectStore('kv'));
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  };
  PS.store = {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
  };

  // STUN servers for NAT traversal, plus the user's TURN relay if they set one.
  PS.iceServers = () => {
    const ice = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
    const t = PS.prefs.turn;
    if (t && t.url) ice.push({ urls: t.url.split(',').map((x) => x.trim()).filter(Boolean), username: t.user || '', credential: t.pass || '' });
    return ice;
  };

  PS.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
})();
