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

  async function prepareGame(files) {
    files = [...files];
    if (files.length === 1) {
      const f = files[0];
      const isArchive = /\.(zip|7z)$/i.test(f.name);
      // Single disc image (.chd .pbp .iso .bin .img) or an archive: hand it over directly.
      // EmulatorJS names blob files after EJS_gameName, so keep the real extension.
      return { url: URL.createObjectURL(f), name: clean(isArchive ? stripExt(f.name) : f.name), title: stripExt(f.name) };
    }
    // Several files (cue + bins, multi-disc): pack them into a store-only zip.
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f);
    const cues = files.filter((f) => /\.cue$/i.test(f.name)).map((f) => f.name).sort();
    if (cues.length > 1 && !files.some((f) => /\.m3u$/i.test(f.name))) {
      zip.file(stripExt(cues[0]) + '.m3u', cues.join('\n'));
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) =>
      handlers.progress && handlers.progress(`Packing disc ${Math.round(m.percent)}%`)
    );
    const lead = cues[0] || files[0].name;
    return { url: URL.createObjectURL(blob), name: clean(stripExt(lead)), title: stripExt(lead) };
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

  async function load(opts) {
    handlers = opts.handlers || {};
    const g = await prepareGame(opts.files);
    gameName = g.name;
    PS.emu.title = g.title;

    window.EJS_player = '#game';
    window.EJS_core = 'psx';
    window.EJS_pathtodata = DATA;
    window.EJS_gameUrl = g.url;
    window.EJS_gameName = g.name;
    window.EJS_startOnLoaded = true;
    window.EJS_color = '#eaa64a';
    window.EJS_defaultOptions = multitapOpts(!!opts.multitap);
    if (opts.bios) window.EJS_biosUrl = await prepareBios(opts.bios);
    const fireStarted = () => {
      if (started) return;
      started = true;
      handlers.started && handlers.started();
    };
    window.EJS_onGameStart = fireStarted;
    // Fallback in case this EmulatorJS build doesn't call EJS_onGameStart.
    const poll = setInterval(() => {
      if (window.EJS_emulator && window.EJS_emulator.started && canvas()) { clearInterval(poll); fireStarted(); }
    }, 500);

    handlers.progress && handlers.progress('Downloading emulator core…');
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = DATA + 'loader.js';
      s.onload = res;
      s.onerror = () => rej(new Error('EmulatorJS could not be downloaded. Check the connection and try again.'));
      document.body.appendChild(s);
    });
    handlers.progress && handlers.progress(null);
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

  async function saveState(slot) {
    const g = gm();
    if (!g) throw new Error('Game is not running');
    await PS.store.set(`state:${gameName}:${slot}`, { at: Date.now(), data: g.getState() });
  }
  async function loadState(slot) {
    const g = gm();
    const rec = await PS.store.get(`state:${gameName}:${slot}`);
    if (!g || !rec) return false;
    g.loadState(rec.data);
    return true;
  }
  async function stateInfo(slot) {
    const rec = await PS.store.get(`state:${gameName}:${slot}`);
    return rec ? rec.at : null;
  }

  function restart() { const g = gm(); g && g.restart(); }
  function setMultitap(on) {
    const g = gm();
    if (!g) return;
    const o = multitapOpts(on);
    for (const k in o) { try { g.setVariable(k, o[k]); } catch (e) {} }
    try { g.restart(); } catch (e) {}
  }
  function toggleFastForward() {
    const g = gm();
    if (!g) return ff;
    ff = !ff;
    try { g.toggleFastForward(ff ? 1 : 0); } catch (e) {}
    return ff;
  }

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
    apply(area, frame, inner, r) {
      const W = area.clientWidth, H = area.clientHeight;
      if (!W || !H) return;
      const asp = (4 * r.w) / (3 * r.h);
      let fw = W, fh = W / asp;
      if (fh > H) { fh = H; fw = H * asp; }
      frame.style.width = fw + 'px';
      frame.style.height = fh + 'px';
      const s = fw / (STAGE_W * r.w);
      inner.style.transform = `scale(${s}) translate(${-r.x * STAGE_W}px, ${-r.y * STAGE_H}px)`;
    },
  };

  PS.emu = {
    load, setInput, releaseAll, captureStream, canvas,
    saveState, loadState, stateInfo, restart, setMultitap, toggleFastForward,
    get started() { return started; },
    title: '',
  };
})();
