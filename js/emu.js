/* PhoStation emulator wrapper (EmulatorJS, PCSX-ReARMed core). Host only. */
(function () {
  const PS = window.PS;
  const DATA = 'https://cdn.emulatorjs.org/stable/data/';
  const STAGE_W = 640, STAGE_H = 480;

  let handlers = {};
  let gameName = 'game';
  let started = false;
  let ff = false;

  // Last state applied per port, so we only send changes to the core.
  const prev = [0, 1, 2, 3].map(() => ({ b: 0, a: [0, 0, 0, 0] }));
  // EmulatorJS analog indices: [positive, negative] per axis (LX, LY, RX, RY)
  const AX = [[16, 17], [18, 19], [20, 21], [22, 23]];

  const gm = () => window.EJS_emulator && window.EJS_emulator.gameManager;
  const clean = (n) => n.replace(/[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/g, '').trim() || 'game';
  const stripExt = (n) => n.replace(/\.[^.]+$/, '');

  // Breadcrumbs survive a crash-reload so the app can say where loading died.
  function crumb(stage) {
    try {
      if (stage) localStorage.setItem('phostation.loading', JSON.stringify({ stage, game: PS.emu.title, at: Date.now() }));
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
  function injectDisc(emu, files, p) {
    if (!emu || typeof emu.downloadRom !== 'function') return false;
    emu.downloadRom = async function () {
      const FS = this.gameManager.FS;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        crumb('disc');
        handlers.progress && handlers.progress(`Loading disc${files.length > 1 ? ` (${i + 1}/${files.length})` : ''}…`);
        const bytes = new Uint8Array(await f.arrayBuffer());
        FS.writeFile('/' + f.name, bytes, { canOwn: true });
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
  const perfOpts = (name) => {
    const o = {};
    const p = PERF[name] || PERF.balanced;
    for (const k in p) o['pcsx_rearmed_' + k] = p[k];
    o.pcsx_rearmed_show_bios_bootlogo = 'disabled';
    return o;
  };
  function setPerf(name) {
    const g = gm();
    if (!g) return;
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
    const M = window.EJS_emulator && window.EJS_emulator.Module;
    const f = M && (M._emscripten_set_main_loop_timing || M.setMainLoopTiming);
    if (typeof f !== 'function') return false;
    try { on ? f(0, 16) : f(1, 1); return true; } catch (e) { return false; }
  }
  function canUncap() {
    const M = window.EJS_emulator && window.EJS_emulator.Module;
    return !!(M && typeof (M._emscripten_set_main_loop_timing || M.setMainLoopTiming) === 'function');
  }

  async function load(opts) {
    handlers = opts.handlers || {};
    const files = [...opts.files];
    const archive = files.length === 1 && isArchive(files[0]);
    const p = archive ? null : plan(files);
    PS.emu.title = stripExt(archive ? files[0].name : p.main);
    gameName = clean(PS.emu.title);
    crumb('core');

    window.EJS_player = '#game';
    window.EJS_core = 'psx';
    window.EJS_pathtodata = DATA;
    // Only fetched by EmulatorJS for .zip/.7z, or if the direct write can't be installed.
    window.EJS_gameUrl = URL.createObjectURL(files[0]);
    window.EJS_gameName = archive ? gameName : clean(files[0].name);
    window.EJS_startOnLoaded = true;
    window.EJS_color = '#eaa64a';
    window.EJS_defaultOptions = Object.assign(perfOpts(opts.perf), multitapOpts(!!opts.multitap));
    if (opts.bios) window.EJS_biosUrl = await prepareBios(opts.bios);

    const fireStarted = () => {
      if (started) return;
      started = true;
      crumb(null);
      handlers.started && handlers.started();
    };
    window.EJS_onGameStart = fireStarted;
    const poll = setInterval(() => {
      if (window.EJS_emulator && window.EJS_emulator.started && canvas()) { clearInterval(poll); fireStarted(); }
    }, 500);

    // Catch the EmulatorJS instance the moment loader.js creates it, before it asks for the ROM.
    let inst;
    let injected = archive;
    Object.defineProperty(window, 'EJS_emulator', {
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
      const s = document.createElement('script');
      s.src = DATA + 'loader.js';
      s.onload = res;
      s.onerror = () => { crumb(null); rej(new Error('EmulatorJS could not be downloaded. Check the connection and try again.')); };
      document.body.appendChild(s);
    });
    if (injected || archive) handlers.progress && handlers.progress(null);
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
    return (window.EJS_emulator && window.EJS_emulator.canvas) || document.querySelector('#game canvas');
  }

  // Video from the emulator canvas + whatever game audio the tap caught.
  async function captureStream() {
    const t0 = Date.now();
    while (!PS.audio.taps.size && Date.now() - t0 < 2500) await new Promise((r) => setTimeout(r, 150));
    const c = canvas();
    const vs = c.captureStream(60);
    const out = new MediaStream();
    vs.getVideoTracks().forEach((t) => { try { t.contentHint = 'motion'; } catch (e) {} out.addTrack(t); });
    PS.audio.taps.forEach((tap) => tap.stream.getAudioTracks().forEach((t) => out.addTrack(t)));
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
    const e = window.EJS_emulator;
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
      const asp = (4 * r.w) / (3 * r.h);
      let fw = W, fh = W / asp;
      if (stretch) fh = H;
      else if (fh > H) { fh = H; fw = H * asp; }
      frame.style.width = fw + 'px';
      frame.style.height = fh + 'px';
      const sx = fw / (STAGE_W * r.w), sy = fh / (STAGE_H * r.h);
      inner.style.transform = `scale(${sx}, ${sy}) translate(${-r.x * STAGE_W}px, ${-r.y * STAGE_H}px)`;
    },
  };

  PS.emu = {
    load, setInput, releaseAll, captureStream, canvas, setPerf, measureFps, setUncapped, canUncap,
    saveState, loadState, crumb, setFastForward, setPaused, screenshot, normalizeCheat, applyCheats, cheatsSupported,
    get paused() { return paused; }, get gameName() { return gameName; }, stateInfo, restart, setMultitap, toggleFastForward,
    get started() { return started; },
    title: '',
  };
})();
