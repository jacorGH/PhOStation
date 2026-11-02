/* PhoStation emulator wrapper (EmulatorJS, PCSX-ReARMed core). Host only. */
(function () {
  const PS = window.PS;
  const DATA = 'https://cdn.emulatorjs.org/stable/data/';
  const STAGE_W = 640;
  let STAGE_H = 480; // 4:3 for PS1; 16:9 (640x363) for PSP, set by PS.view.setSystem

  let handlers = {};
  let gameName = 'game';
  let started = false;
  let ff = false;

  // Last state applied per port, so we only send changes to the core.
  const prev = [0, 1, 2, 3].map(() => ({ b: 0, a: [0, 0, 0, 0] }));
  // EmulatorJS analog indices: [positive, negative] per axis (LX, LY, RX, RY)
  const AX = [[16, 17], [18, 19], [20, 21], [22, 23]];

  // The emulator lives in an iframe (emu.html). W is that frame's window.
  let frameEl = null, W = null, poll = null, look = { filter: 'sharp', ejsUi: false }, system = 'psx';
  const emu = () => W && W.EJS_emulator;
  const gm = () => emu() && emu().gameManager;
  const clean = (n) => n.replace(/[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/g, '').trim() || 'game';
  const stripExt = (n) => n.replace(/\.[^.]+$/, '');

  // Breadcrumbs survive a crash-reload so the app can say where loading died.
  function crumb(stage) {
    try {
      if (stage) localStorage.setItem('phostation.loading', JSON.stringify({ stage, game: PS.emu.title, system, at: Date.now() }));
      else localStorage.removeItem('phostation.loading');
    } catch (e) {}
  }

  const isArchive = (f) => /\.(zip|7z|rar)$/i.test(f.name);

  // Decide which file the core should boot and whether we need a generated playlist.
  function plan(files) {
    const cues = files.filter((f) => /\.cue$/i.test(f.name)).map((f) => f.name).sort();
    const m3u = files.find((f) => /\.m3u$/i.test(f.name));
    let main, playlist = null;
    if (m3u) main = m3u.name;
    else if (cues.length > 1) { main = stripExt(cues[0]) + '.m3u'; playlist = cues.join('\n'); }
    else if (cues.length === 1) main = cues[0];
    else main = files[0].name;
    return { main, playlist };
  }

  // Replace EmulatorJS's ROM download with a direct write into its file system.
  // The disc is read once and handed over without copying (canOwn), which keeps
  // memory at about 1x the disc size instead of 3-4x. iOS reloads the tab when it runs out.
  // ---------- streaming disc ----------
  // Big discs aren't copied into memory. The emulator gets a "lazy" file: when the game reads part
  // of it, that 1 MB piece is fetched from storage (synchronously, since the emulator's file reads
  // are synchronous) and a small cache keeps recent pieces. Memory stays around 32 MB for any disc
  // size, which is what lets 1-2 GB PSP games load on iPhone.
  const STREAM_MIN = 64 * 1024 * 1024; // smaller files are simply copied in
  const CHUNK = 1024 * 1024;
  const CACHE_CHUNKS = 32;

  const discStats = { readMB: 0, fetchedMB: 0, biggestMB: 0, bigReads: 0 };

  // One synchronous read of [start, end) from the blob, returned as text (1 char per byte).
  // Safari only allows text for synchronous reads on the page, so keep these small and short-lived.
  function syncText(blob, start, end) {
    const url = URL.createObjectURL(blob.slice(start, end));
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.overrideMimeType('text/plain; charset=x-user-defined');
      xhr.send(null);
      return xhr.responseText;
    } finally { URL.revokeObjectURL(url); }
  }
  // Write text bytes straight into the destination, without an extra copy.
  function textInto(s, dest, at) {
    if (dest instanceof Uint8Array) { for (let k = 0; k < s.length; k++) dest[at + k] = s.charCodeAt(k); }
    else { for (let k = 0; k < s.length; k++) { const v = s.charCodeAt(k) & 0xff; dest[at + k] = v > 127 ? v - 256 : v; } }
  }

  function chunkReader(blob) {
    const cache = new Map(); // chunk index -> Uint8Array (Map keeps insertion order for LRU)
    function load(i) {
      let c = cache.get(i);
      if (c) { cache.delete(i); cache.set(i, c); return c; }
      discStats.fetchedMB += CHUNK / 1048576;
      const s = syncText(blob, i * CHUNK, Math.min(blob.size, (i + 1) * CHUNK));
      c = new Uint8Array(s.length);
      for (let k = 0; k < s.length; k++) c[k] = s.charCodeAt(k) & 0xff;
      cache.set(i, c);
      if (cache.size > CACHE_CHUNKS) cache.delete(cache.keys().next().value);
      return c;
    }
    // Copy `length` bytes from `position` into `dest` (a typed array) at `offset`.
    return function read(dest, offset, length, position) {
      const n = Math.max(0, Math.min(length, blob.size - position));
      const mb = n / 1048576;
      discStats.readMB += mb;
      if (mb > discStats.biggestMB) discStats.biggestMB = mb;
      // Big reads (scene and movie loading) go straight from storage into the emulator in 256 KB
      // slices: no cache churn and only a little temporary text alive at any moment.
      if (n >= 2 * CHUNK) {
        discStats.bigReads++;
        const SLICE = 256 * 1024;
        for (let done = 0; done < n; done += SLICE) {
          const take = Math.min(SLICE, n - done);
          const s = syncText(blob, position + done, position + done + take);
          discStats.fetchedMB += take / 1048576;
          textInto(s, dest, offset + done);
        }
        return n;
      }
      let done = 0;
      while (done < n) {
        const pos = position + done;
        const c = load(Math.floor(pos / CHUNK));
        const from = pos % CHUNK;
        const take = Math.min(n - done, c.length - from);
        const src = c.subarray(from, from + take);
        if (dest instanceof Uint8Array) dest.set(src, offset + done);
        else new Uint8Array(dest.buffer, dest.byteOffset + offset + done, take).set(src);
        done += take;
      }
      return n;
    };
  }

  // A read-only file in the emulator's file system (Emscripten MEMFS) whose bytes come from `blob`.
  // Same approach as Emscripten's own createLazyFile, which only works inside workers.
  function mountStreaming(FS, name, blob) {
    const node = FS.createFile('/', name, {}, true, false);
    const read = chunkReader(blob);
    node.contents = { length: blob.size, streaming: true }; // non-empty, so MEMFS treats it as loaded
    Object.defineProperty(node, 'usedBytes', { configurable: true, get: () => blob.size }); // file size for stat/seek
    const ops = Object.assign({}, node.stream_ops);
    ops.read = (stream, buffer, offset, length, position) => read(buffer, offset, length, position);
    ops.write = () => { throw new FS.ErrnoError(63); }; // read-only
    node.stream_ops = ops;
    return node;
  }

  function injectDisc(emu, files, p) {
    if (!emu || typeof emu.downloadRom !== 'function') return false;
    emu.downloadRom = async function () {
      const FS = this.gameManager.FS;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        crumb(f.size >= STREAM_MIN ? 'stream' : 'disc');
        handlers.progress && handlers.progress(`Loading disc${files.length > 1 ? ` (${i + 1}/${files.length})` : ''}…`);
        let streamed = false;
        if (f.size >= STREAM_MIN && typeof FS.createFile === 'function') {
          try { mountStreaming(FS, f.name, f); streamed = true; }
          catch (e) { console.warn('[phostation] streaming mount failed, copying instead:', e); }
        }
        if (!streamed) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          FS.writeFile('/' + f.name, bytes, { canOwn: true });
        }
      }
      if (p.playlist) FS.writeFile('/' + p.main, p.playlist);
      this.fileName = p.main;
      crumb('boot');
      handlers.progress && handlers.progress(null);
    };
    return true;
  }

  async function prepareBios(file) {
    if (!file) return null;
    let n = file.name;
    if (/^scph-?\d+/i.test(n)) n = n.toLowerCase().replace('scph-', 'scph');
    const zip = new JSZip();
    zip.file(n, file);
    return URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
  }

  // Core-option names differ between PCSX-ReARMed versions; set both, unknown keys are ignored.
  const multitapOpts = (on) => ({
    pcsx_rearmed_multitap: on ? 'port 1' : 'disabled',
    pcsx_rearmed_multitap1: on ? 'enabled' : 'disabled',
    pcsx_rearmed_multitap2: 'disabled',
  });

  // Speed presets for PCSX-ReARMed. Both old and new option names are set; unknown keys are ignored.
  const PERF = {
    quality:  { frameskip_type: 'disabled', frameskip: '0', frameskip_interval: '1', psxclock: '57', spu_interpolation: 'gaussian', spu_reverb: 'enabled', dithering: 'enabled' },
    balanced: { frameskip_type: 'auto', frameskip: '0', frameskip_interval: '1', psxclock: '57', spu_interpolation: 'simple', spu_reverb: 'enabled', dithering: 'disabled' },
    fast:     { frameskip_type: 'auto', frameskip: '1', frameskip_interval: '1', psxclock: '50', spu_interpolation: 'off', spu_reverb: 'disabled', dithering: 'disabled' },
    turbo:    { frameskip_type: 'fixed_interval', frameskip: '1', frameskip_interval: '1', psxclock: '45', spu_interpolation: 'off', spu_reverb: 'disabled', dithering: 'disabled' },
  };
  // PSP (PPSSPP) settings that keep memory and work down on phones: native resolution, no texture
  // upscaling or replacement, textures cached lazily. Unknown option names are ignored by the core.
  const PSP_LIGHT = {
    ppsspp_internal_resolution: '480x272',
    ppsspp_texture_scaling_level: 'disabled',
    ppsspp_texture_scaling_type: 'xbrz',
    ppsspp_texture_deposterize: 'disabled',
    ppsspp_texture_replacement: 'disabled',
    ppsspp_lazy_texture_caching: 'enabled',
    ppsspp_texture_filtering: 'auto',
    ppsspp_fast_memory: 'enabled',
    ppsspp_spline_quality: 'low',
  };
  const perfOpts = (name) => {
    const o = {};
    const p = PERF[name] || PERF.balanced;
    for (const k in p) o['pcsx_rearmed_' + k] = p[k];
    o.pcsx_rearmed_show_bios_bootlogo = 'disabled';
    return o;
  };
  function setPerf(name) {
    const g = gm();
    if (!g || system !== 'psx') return; // presets are PS1 (PCSX-ReARMed) options
    const o = perfOpts(name);
    for (const k in o) { try { g.setVariable(k, o[k]); } catch (e) {} }
  }

  // Average screen refresh the browser gives us. Low Power Mode on iPhone caps it at 30.
  function measureFps(ms = 2000) {
    return new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const tick = (t) => { n++; if (t - t0 < ms) requestAnimationFrame(tick); else res((n * 1000) / (t - t0)); };
      requestAnimationFrame(tick);
    });
  }
  // Run the emulator on a 60 Hz timer instead of the (possibly throttled) display refresh.
  function setUncapped(on) {
    const M = emu() && emu().Module;
    const f = M && (M._emscripten_set_main_loop_timing || M.setMainLoopTiming);
    if (typeof f !== 'function') return false;
    try { on ? f(0, 16) : f(1, 1); return true; } catch (e) { return false; }
  }
  function canUncap() {
    const M = emu() && emu().Module;
    return !!(M && typeof (M._emscripten_set_main_loop_timing || M.setMainLoopTiming) === 'function');
  }

  // ---------- heartbeat ----------
  // Every 10 s while a game runs: uptime, emulator memory, emulator frame rate, disc reading.
  // Written straight to the saved log, so the last line before a crash survives it.
  let beatTimer = null;
  function heapMB() {
    try {
      const M = emu() && emu().Module;
      const buf = (M && ((M.HEAPU8 && M.HEAPU8.buffer) || (M.wasmMemory && M.wasmMemory.buffer) || (M.asm && M.asm.memory && M.asm.memory.buffer))) || null;
      return buf ? Math.round(buf.byteLength / 1048576) : null;
    } catch (e) { return null; }
  }
  function frameNum() {
    try { const g = gm(); return g && typeof g.getFrameNum === 'function' ? g.getFrameNum() : null; } catch (e) { return null; }
  }
  // Watchdog thread: tells a frozen page apart from one killed for memory (see watchdog-worker.js).
  let dog = null, dogTimer = null;
  function startWatchdog() {
    try {
      if (!dog) dog = new Worker('js/watchdog-worker.js');
      dog.postMessage({ start: true, game: PS.emu.title });
      clearInterval(dogTimer);
      dogTimer = setInterval(() => dog.postMessage({ ping: 1 }), 500);
    } catch (e) {}
  }
  function stopWatchdog() { clearInterval(dogTimer); try { dog && dog.postMessage({ stop: true }); } catch (e) {} }
  document.addEventListener('visibilitychange', () => { try { dog && dog.postMessage({ hidden: document.visibilityState === 'hidden' }); } catch (e) {} });

  function startHeartbeat() {
    clearInterval(beatTimer);
    startWatchdog();
    const t0 = Date.now();
    let lastFrame = frameNum(), lastAt = Date.now();
    Object.assign(discStats, { readMB: 0, fetchedMB: 0, biggestMB: 0, bigReads: 0 });
    beatTimer = setInterval(() => {
      if (!W || !W.__emuLog) return;
      const secs = Math.round((Date.now() - t0) / 1000);
      const f = frameNum(), now = Date.now();
      const fps = f != null && lastFrame != null ? Math.round(((f - lastFrame) * 1000) / (now - lastAt)) : null;
      lastFrame = f; lastAt = now;
      const heap = heapMB();
      W.__emuLog('beat', [`[phostation] ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} running,`
        + ` memory ${heap != null ? heap + ' MB' : 'n/a'}, ${fps != null ? fps + ' fps' : 'fps n/a'}${paused ? ' (paused)' : ''},`
        + ` disc read ${Math.round(discStats.readMB)} MB (fetched ${Math.round(discStats.fetchedMB)} MB),`
        + ` biggest read ${discStats.biggestMB.toFixed(1)} MB, big reads ${discStats.bigReads}`]);
      discStats.biggestMB = 0; // per interval, so a spike right before a crash stands out
    }, 5000);
  }

  document.addEventListener('visibilitychange', () => {
    try { if (started && W && W.__emuLog) W.__emuLog('beat', [`[phostation] app ${document.visibilityState}`]); } catch (e) {}
  });

  // Leaving or closing the page normally isn't a crash.
  addEventListener('pagehide', (e) => { if (!e.persisted) { crumb(null); stopWatchdog(); } });

  function makeFrame() {
    return new Promise((res, rej) => {
      const holder = document.getElementById('game');
      holder.innerHTML = '';
      const f = document.createElement('iframe');
      f.src = 'emu.html';
      f.title = 'Emulator';
      f.setAttribute('allow', 'autoplay; gamepad; fullscreen');
      f.onload = () => res(f);
      f.onerror = () => rej(new Error('The emulator frame didn\u2019t load.'));
      holder.appendChild(f);
    });
  }
  function applyLook() {
    try {
      W.document.documentElement.dataset.filter = look.filter;
      W.document.body.classList.toggle('ejs-ui', look.ejsUi);
    } catch (e) {}
  }
  // Touches land on the main page, so wake the frame's audio from here.
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => addEventListener(ev, () => {
    try { W && W.PS && W.PS.audio.contexts.forEach((c) => c.state === 'suspended' && c.resume().catch(() => {})); } catch (e) {}
    if (ev !== 'keydown') dismissResume();
  }, { capture: true, passive: true }));
  // EmulatorJS shows "Click to resume Emulator" when Safari blocks sound until a tap inside the
  // emulator. Taps land on our controller instead, so pass this one through (during a real touch,
  // so Safari counts it as the user's tap).
  function dismissResume() {
    try {
      if (!W || !W.document) return;
      const walker = W.document.createTreeWalker(W.document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (/click to resume/i.test(n.nodeValue) && n.parentElement && n.parentElement.offsetParent !== null) {
          const el = n.parentElement;
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchstart', 'touchend'].forEach((t) => {
            try { el.dispatchEvent(new W.Event(t, { bubbles: true, cancelable: true })); } catch (e) {}
          });
          return;
        }
      }
    } catch (e) {}
  }

  async function load(opts) {
    handlers = opts.handlers || {};
    if (frameEl) await unload();
    const files = [...opts.files];
    const archive = files.length === 1 && isArchive(files[0]);
    const p = archive ? null : plan(files);
    PS.emu.title = stripExt(archive ? files[0].name : p.main);
    gameName = clean(PS.emu.title);
    crumb('core');

    frameEl = await makeFrame();
    W = frameEl.contentWindow;
    applyLook();

    W.EJS_player = '#game';
    system = opts.system === 'psp' ? 'psp' : 'psx';
    W.EJS_core = system;
    if (system === 'psp') W.EJS_threads = true; // PPSSPP only runs threaded
    W.EJS_pathtodata = DATA;
    // Only fetched by EmulatorJS for .zip/.7z, or if the direct write can't be installed.
    W.EJS_gameUrl = URL.createObjectURL(files[0]);
    W.EJS_gameName = archive ? gameName : clean(files[0].name);
    W.EJS_startOnLoaded = true;
    if (opts.debug) W.EJS_DEBUG_XX = true; // EmulatorJS debug mode: the core's own messages reach the log
    W.EJS_color = '#eaa64a';
    W.EJS_defaultOptions = system === 'psp' ? Object.assign({}, PSP_LIGHT) : Object.assign(perfOpts(opts.perf), multitapOpts(!!opts.multitap));
    if (opts.bios && system === 'psx') W.EJS_biosUrl = await prepareBios(opts.bios);

    const fireStarted = () => {
      if (started) return;
      started = true;
      crumb('running');
      try { W.__emuLog('beat', [`[phostation] build ${PS.build}, ${system.toUpperCase()} ${PS.emu.title}, ${PS.system.isWebKitOnly ? 'iPhone/iPad' : 'other'}${opts.debug ? ', detailed log' : ''}`]); } catch (e) {}
      startHeartbeat();
      handlers.started && handlers.started();
    };
    W.EJS_onGameStart = fireStarted;
    clearInterval(poll);
    poll = setInterval(() => {
      if (emu() && emu().started && canvas()) { clearInterval(poll); fireStarted(); }
    }, 500);

    // Catch the EmulatorJS instance the moment loader.js creates it, before it asks for the ROM.
    let inst;
    let injected = archive;
    Object.defineProperty(W, 'EJS_emulator', {
      configurable: true,
      get: () => inst,
      set: (v) => {
        inst = v;
        if (!archive) {
          injected = injectDisc(v, files, p);
          if (!injected && files.length > 1) {
            handlers.progress && handlers.progress('This EmulatorJS version can\u2019t load .cue/.bin sets. Convert the disc to .chd or .pbp.');
          }
        }
      },
    });

    handlers.progress && handlers.progress('Downloading emulator core…');
    await new Promise((res, rej) => {
      const s = W.document.createElement('script');
      s.src = DATA + 'loader.js';
      s.onload = res;
      s.onerror = () => { crumb(null); rej(new Error('EmulatorJS could not be downloaded. Check the connection and try again.')); };
      W.document.body.appendChild(s);
    });
    if (injected || archive) handlers.progress && handlers.progress(null);
  }

  // Close the current game: flush memory-card saves, then drop the whole frame (frees its memory).
  async function unload() {
    clearInterval(poll);
    clearInterval(beatTimer);
    stopWatchdog();
    crumb(null);
    try { const g = gm(); if (g && typeof g.saveSaveFiles === 'function') g.saveSaveFiles(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 800)); // let the save reach storage
    try { W && W.PS && W.PS.audio.contexts.forEach((c) => c.close().catch(() => {})); } catch (e) {}
    if (frameEl) frameEl.remove();
    frameEl = null; W = null;
    started = false; paused = false; ff = false;
    prev.forEach((p) => { p.b = 0; p.a = [0, 0, 0, 0]; });
  }

  function setInput(port, st) {
    const g = gm();
    if (!g || port == null || port < 0 || port > 3) return;
    const p = prev[port];
    const diff = p.b ^ st.b;
    if (diff) for (let i = 0; i < 16; i++) if (diff & (1 << i)) g.simulateInput(port, i, (st.b >> i) & 1);
    for (let k = 0; k < 4; k++) {
      const v = Math.max(-1, Math.min(1, +(st.a && st.a[k]) || 0));
      if (v === p.a[k]) continue;
      g.simulateInput(port, AX[k][0], v > 0 ? Math.round(v * 0x7fff) : 0);
      g.simulateInput(port, AX[k][1], v < 0 ? Math.round(-v * 0x7fff) : 0);
      p.a[k] = v;
    }
    p.b = st.b;
  }
  const releaseAll = (port) => setInput(port, { b: 0, a: [0, 0, 0, 0] });

  function canvas() {
    return (emu() && emu().canvas) || (W && W.document.querySelector('#game canvas'));
  }

  // Video from the emulator canvas + whatever game audio the tap caught.
  async function captureStream() {
    const t0 = Date.now();
    const taps = () => (W && W.PS ? W.PS.audio.taps : new Map());
    while (!taps().size && Date.now() - t0 < 2500) await new Promise((r) => setTimeout(r, 150));
    const c = canvas();
    const vs = c.captureStream(60);
    const out = new MediaStream();
    vs.getVideoTracks().forEach((t) => { try { t.contentHint = 'motion'; } catch (e) {} out.addTrack(t); });
    taps().forEach((tap) => tap.stream.getAudioTracks().forEach((t) => out.addTrack(t)));
    return out;
  }

  // Small JPEG of the current frame, used for save-state previews.
  function thumb(w = 160) {
    try {
      const c = canvas();
      if (!c || !c.width) return null;
      const t = document.createElement('canvas');
      t.width = w; t.height = Math.round((w * 3) / 4);
      t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
      return t.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; }
  }

  async function saveState(slot) {
    const g = gm();
    if (!g || !started) throw new Error('Game is not running');
    await PS.store.set(`state:${gameName}:${slot}`, { at: Date.now(), data: g.getState(), thumb: thumb() });
  }
  async function loadState(slot) {
    const g = gm();
    const rec = await PS.store.get(`state:${gameName}:${slot}`);
    if (!g || !rec) return false;
    g.loadState(rec.data);
    return true;
  }
  // { at, thumb } or null
  async function stateInfo(slot, name = gameName) {
    const rec = await PS.store.get(`state:${name}:${slot}`);
    return rec ? { at: rec.at, thumb: rec.thumb || null } : null;
  }

  let paused = false;
  function setPaused(on) {
    const e = emu();
    const g = gm();
    if (!e || !g) return paused;
    try {
      if (on && typeof e.pause === 'function') e.pause();
      else if (!on && typeof e.play === 'function') e.play();
      else g.toggleMainLoop(on ? 0 : 1);
      paused = on;
    } catch (err) {}
    return paused;
  }

  // PNG of the current frame (host). Guests capture from the video instead.
  function screenshot() {
    return new Promise((res) => {
      const c = canvas();
      if (!c) return res(null);
      c.toBlob((b) => res(b), 'image/png');
    });
  }

  // GameShark codes: "80012345 0063" per line. Lines are joined with + as libretro expects.
  function normalizeCheat(code) {
    const lines = code.toUpperCase().split(/[\n+]/).map((l) => l.replace(/[^0-9A-F]/g, '')).filter(Boolean);
    if (!lines.length || lines.some((l) => l.length !== 12)) return null;
    return lines.map((l) => l.slice(0, 8) + ' ' + l.slice(8)).join('+');
  }
  function applyCheats(list) {
    const g = gm();
    if (!g || typeof g.setCheat !== 'function') return false;
    try { if (typeof g.resetCheat === 'function') g.resetCheat(); } catch (e) {}
    (list || []).forEach((c, i) => {
      const code = normalizeCheat(c.code);
      if (code) { try { g.setCheat(i, c.on ? 1 : 0, code); } catch (e) {} }
    });
    return true;
  }
  const cheatsSupported = () => { const g = gm(); return !!(g && typeof g.setCheat === 'function'); };

  function restart() { const g = gm(); g && g.restart(); }
  function setMultitap(on) {
    const g = gm();
    if (!g) return;
    const o = multitapOpts(on);
    for (const k in o) { try { g.setVariable(k, o[k]); } catch (e) {} }
    try { g.restart(); } catch (e) {}
  }
  function setFastForward(on) {
    const g = gm();
    if (!g) return ff;
    ff = !!on;
    try { g.toggleFastForward(ff ? 1 : 0); } catch (e) {}
    return ff;
  }
  const toggleFastForward = () => setFastForward(!ff);

  // ---------- split-view math (shared by host stage and guest video) ----------
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  PS.view = {
    FULL,
    rect(mode, port) {
      if (port == null) return FULL;
      switch (mode) {
        case 'h2': return { x: 0, y: (port % 2) * 0.5, w: 1, h: 0.5 };
        case 'v2': return { x: (port % 2) * 0.5, y: 0, w: 0.5, h: 1 };
        case 'q4': return { x: (port % 2) * 0.5, y: (Math.floor(port / 2) % 2) * 0.5, w: 0.5, h: 0.5 };
        default: return FULL;
      }
    },
    // stretch: fill the whole area instead of keeping the 4:3 shape
    apply(area, frame, inner, r, stretch) {
      const W = area.clientWidth, H = area.clientHeight;
      if (!W || !H) return;
      const asp = (STAGE_W * r.w) / (STAGE_H * r.h);
      let fw = W, fh = W / asp;
      if (stretch) fh = H;
      else if (fh > H) { fh = H; fw = H * asp; }
      frame.style.width = fw + 'px';
      frame.style.height = fh + 'px';
      const sx = fw / (STAGE_W * r.w), sy = fh / (STAGE_H * r.h);
      inner.style.transform = `scale(${sx}, ${sy}) translate(${-r.x * STAGE_W}px, ${-r.y * STAGE_H}px)`;
    },
    // The PSP screen is 480x272 (about 16:9); the PS1's is 4:3.
    setSystem(system) {
      STAGE_H = system === 'psp' ? Math.round((STAGE_W * 272) / 480) : 480;
      document.documentElement.style.setProperty('--stage-h', STAGE_H + 'px');
      const play = document.getElementById('play');
      if (play) play.dataset.system = system === 'psp' ? 'psp' : 'psx';
    },
  };

  PS.emu = {
    load, setInput, releaseAll, captureStream, canvas, setPerf, measureFps, setUncapped, canUncap,
    saveState, loadState, crumb, setFastForward, _mountStreaming: mountStreaming, _chunkReader: chunkReader, setPaused, screenshot, normalizeCheat, applyCheats, cheatsSupported,
    // Emulator console messages from the current run (or the previous one, e.g. after a crash).
    log() {
      for (const k of ['phostation.emulog', 'phostation.emulog.prev']) {
        try { const l = JSON.parse(localStorage.getItem(k) || '[]'); if (l.length) return l; } catch (e) {}
      }
      return [];
    },
    get paused() { return paused; }, get gameName() { return gameName; }, get system() { return system; }, unload,
    setFilter(f) { look.filter = f; applyLook(); },
    setEjsUi(on) { look.ejsUi = !!on; applyLook(); }, stateInfo, restart, setMultitap, toggleFastForward,
    get started() { return started; },
    title: '',
  };
})();
