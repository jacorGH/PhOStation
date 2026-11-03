/* PhoStation boot — must load BEFORE EmulatorJS.
   1) Forces preserveDrawingBuffer so canvas.captureStream() never sends black frames.
   2) Taps every Web Audio graph that reaches the speakers so game audio can be streamed.
   3) Tiny prefs + IndexedDB helpers shared by the other modules. */
(function () {
  const PS = (window.PS = window.PS || {});
  // Bump with every release, so logs and Settings show exactly which version ran.
  PS.build = '2026.11.02-r10';

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

  // ---------- 1c. Graphics memory accounting (for the heartbeat) ----------
  // Counts live WebGL textures/buffers/renderbuffers and roughly how many bytes they hold, plus
  // upload traffic. Helps spot graphics memory piling up (e.g. during video), which the emulator's
  // own memory figure doesn't include.
  PS.gpu = { textures: 0, buffers: 0, renderbuffers: 0, bytes: 0, uploaded: 0 };
  try {
    const G = PS.gpu;
    const sizes = new WeakMap();                  // object -> bytes
    const bpp = (fmt) => (fmt === 0x8814 || fmt === 0x8C3A ? 16 : fmt === 0x881A ? 8 : 4); // RGBA32F, R11G11B10F, RGBA16F
    const patch = (proto) => {
      if (!proto || proto.__psGpu) return;
      proto.__psGpu = true;
      const units = new Map();                    // context -> { unit, tex: {unit:target:tex}, rb, buf }
      const st = (gl) => { let s = units.get(gl); if (!s) units.set(gl, (s = { unit: 0, tex: {}, rb: null, buf: {} })); return s; };
      const setSize = (obj, bytes) => { if (!obj) return; G.bytes += bytes - (sizes.get(obj) || 0); sizes.set(obj, bytes); };
      const wrap = (name, fn) => { const o = proto[name]; if (o) proto[name] = function (...a) { return fn.call(this, o, a); }; };
      wrap('createTexture', function (o, a) { G.textures++; return o.apply(this, a); });
      wrap('deleteTexture', function (o, a) { if (a[0]) { G.textures--; setSize(a[0], 0); } return o.apply(this, a); });
      wrap('createBuffer', function (o, a) { G.buffers++; return o.apply(this, a); });
      wrap('deleteBuffer', function (o, a) { if (a[0]) { G.buffers--; setSize(a[0], 0); } return o.apply(this, a); });
      wrap('createRenderbuffer', function (o, a) { G.renderbuffers++; return o.apply(this, a); });
      wrap('deleteRenderbuffer', function (o, a) { if (a[0]) { G.renderbuffers--; setSize(a[0], 0); } return o.apply(this, a); });
      wrap('activeTexture', function (o, a) { st(this).unit = a[0]; return o.apply(this, a); });
      wrap('bindTexture', function (o, a) { st(this).tex[st(this).unit + ':' + a[0]] = a[1]; return o.apply(this, a); });
      wrap('bindRenderbuffer', function (o, a) { st(this).rb = a[1]; return o.apply(this, a); });
      wrap('bindBuffer', function (o, a) { st(this).buf[a[0]] = a[1]; return o.apply(this, a); });
      const bound = (gl, target) => st(gl).tex[st(gl).unit + ':' + (target >= 0x8515 && target <= 0x851A ? 0x8513 : target)];
      wrap('texStorage2D', function (o, a) { const [t, levels, fmt, w, h] = a; setSize(bound(this, t), w * h * bpp(fmt) * (levels > 1 ? 1.34 : 1)); return o.apply(this, a); });
      wrap('texImage2D', function (o, a) {
        if (a[1] === 0) { // level 0 decides the size
          const w = a.length >= 8 ? a[3] : (a[5] && (a[5].videoWidth || a[5].width)) || 0;
          const h = a.length >= 8 ? a[4] : (a[5] && (a[5].videoHeight || a[5].height)) || 0;
          setSize(bound(this, a[0]), w * h * bpp(a[2]));
          G.uploaded += w * h * 4;
        }
        return o.apply(this, a);
      });
      wrap('texSubImage2D', function (o, a) {
        const w = a.length >= 9 ? a[4] : (a[6] && (a[6].videoWidth || a[6].width)) || 0;
        const h = a.length >= 9 ? a[5] : (a[6] && (a[6].videoHeight || a[6].height)) || 0;
        G.uploaded += w * h * 4;
        return o.apply(this, a);
      });
      wrap('renderbufferStorage', function (o, a) { setSize(st(this).rb, a[2] * a[3] * 4); return o.apply(this, a); });
      wrap('renderbufferStorageMultisample', function (o, a) { setSize(st(this).rb, a[3] * a[4] * 4 * Math.max(1, a[1])); return o.apply(this, a); });
      wrap('bufferData', function (o, a) {
        const n = typeof a[1] === 'number' ? a[1] : (a[1] && a[1].byteLength) || 0;
        setSize(st(this).buf[a[0]], n);
        G.uploaded += n;
        return o.apply(this, a);
      });
    };
    if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
    if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype);
  } catch (e) { /* accounting is best-effort; never break rendering */ }

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
  if (p.shareRelay === undefined) p.shareRelay = true;
  PS.prefs = new Proxy(p, { set(t, k, v) { t[k] = v; save(); return true; } });

  // A per-tab identity: survives reloads/reconnects, distinct per tab.
  let cid = null;
  try { cid = sessionStorage.getItem('phostation.cid'); } catch (e) {}
  if (!cid) {
    cid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { sessionStorage.setItem('phostation.cid', cid); } catch (e) {}
  }
  PS.clientId = cid;
  // Identity for a room, kept on this device, so reopening the app or the tab still counts as
  // the same player and gets their port back.
  PS.clientIdFor = (room) => {
    let map = {};
    try { map = JSON.parse(localStorage.getItem('phostation.ids') || '{}'); } catch (e) {}
    const now = Date.now();
    for (const k in map) if (now - map[k].at > 30 * 864e5) delete map[k];
    if (!map[room]) map[room] = { id: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + now.toString(36)) };
    map[room].at = now;
    try { localStorage.setItem('phostation.ids', JSON.stringify(map)); } catch (e) {}
    return (PS.clientId = map[room].id);
  };

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

  PS.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
})();
