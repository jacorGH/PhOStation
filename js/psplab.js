/* PSP lab: finds out exactly which browser features the PSP emulator (PPSSPP compiled to
   WebAssembly with threads) can and can't get on this device, so we know what to fix.
   Each probe is small and wrapped, and the results come back as a copyable text report. */
(function () {
  const PS = window.PS;
  const PAGE = 65536; // WebAssembly page size (64 KiB)

  // Largest shared WebAssembly memory this browser will reserve. Threaded builds need one up front.
  function sharedMemoryMax() {
    if (typeof WebAssembly === 'undefined' || typeof SharedArrayBuffer === 'undefined') return { ok: false, max: 0, note: 'no SharedArrayBuffer' };
    let best = 0, err = '';
    for (const mb of [256, 512, 1024, 2048, 4095]) {
      try {
        const m = new WebAssembly.Memory({ initial: 16, maximum: (mb * 1024 * 1024) / PAGE, shared: true });
        if (!(m.buffer instanceof SharedArrayBuffer)) { err = 'memory is not shared'; break; }
        best = mb;
      } catch (e) { err = e.message; break; }
    }
    return { ok: best > 0, max: best, note: err };
  }

  // Can a worker thread wait on and wake another through shared memory (what pthreads do)?
  function threadRoundTrip() {
    return new Promise((res) => {
      try {
        const sab = new SharedArrayBuffer(8);
        const view = new Int32Array(sab);
        const src = 'onmessage=function(e){var v=new Int32Array(e.data);Atomics.store(v,0,42);Atomics.notify(v,0);postMessage("done")}';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        const t = setTimeout(() => { w.terminate(); res({ ok: false, note: 'worker never answered' }); }, 3000);
        w.onmessage = () => { clearTimeout(t); w.terminate(); res({ ok: Atomics.load(view, 0) === 42, note: '' }); };
        w.onerror = (e) => { clearTimeout(t); w.terminate(); res({ ok: false, note: e.message || 'worker error' }); };
        w.postMessage(sab);
      } catch (e) { res({ ok: false, note: e.message }); }
    });
  }

  // Can a worker draw with WebGL 2 on an OffscreenCanvas (some threaded builds render off the main thread)?
  function offscreenWebGL2() {
    return new Promise((res) => {
      if (typeof OffscreenCanvas === 'undefined') return res({ ok: false, note: 'no OffscreenCanvas' });
      try {
        const src = 'onmessage=function(){try{var c=new OffscreenCanvas(4,4);postMessage(!!c.getContext("webgl2"))}catch(e){postMessage("err:"+e.message)}}';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        const t = setTimeout(() => { w.terminate(); res({ ok: false, note: 'timed out' }); }, 3000);
        w.onmessage = (e) => { clearTimeout(t); w.terminate(); res({ ok: e.data === true, note: typeof e.data === 'string' ? e.data : '' }); };
        w.postMessage(0);
      } catch (e) { res({ ok: false, note: e.message }); }
    });
  }

  // WebGL 2 details PPSSPP cares about: limits and float render targets.
  function webgl2Info() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false };
      const ext = (n) => !!gl.getExtension(n);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        colorBufferFloat: ext('EXT_color_buffer_float'),
        colorBufferHalfFloat: ext('EXT_color_buffer_half_float'),
        floatLinear: ext('OES_texture_float_linear'),
        anisotropic: ext('EXT_texture_filter_anisotropic'),
      };
    } catch (e) { return { ok: false, note: e.message }; }
  }

  // WebAssembly SIMD: validate a tiny module that uses a v128 instruction.
  function wasmSimd() {
    try {
      const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
      return WebAssembly.validate(bytes);
    } catch (e) { return false; }
  }

  async function run() {
    const ua = navigator.userAgent;
    const ios = (ua.match(/OS (\d+)_(\d+)/) || []).slice(1).join('.');
    const mem = sharedMemoryMax();
    const [thr, off] = await Promise.all([threadRoundTrip(), offscreenWebGL2()]);
    const gl = webgl2Info();
    const r = {
      device: { ios: ios || null, safari: (ua.match(/Version\/([\d.]+)/) || [])[1] || null, cores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null },
      isolated: !!window.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      sharedMemoryMaxMB: mem.max, sharedMemoryNote: mem.note,
      threads: thr.ok, threadsNote: thr.note,
      atomicsWaitAsync: typeof Atomics !== 'undefined' && typeof Atomics.waitAsync === 'function',
      offscreenWebGL2: off.ok, offscreenNote: off.note,
      webgl2: gl,
      audioWorklet: typeof AudioWorkletNode === 'function',
      wasmSimd: wasmSimd(),
      experimentOn: !!PS.prefs.pspExperimental,
    };
    const w = await PS.system.lastWatchdog();
    r.lastSession = w ? { frozenBeforeEnd: w.frozen, note: w.text, watchdog: w.raw } : null;
    r.verdict = verdict(r);
    return r;
  }

  // Plain-language reading of the results.
  function verdict(r) {
    const out = [];
    if (!r.isolated) out.push({ level: 'bad', text: 'Cross-origin isolation is off, so threads can\u2019t start. Turn on the experiment and reload; if it stays off, Safari isn\u2019t accepting the setting.' });
    if (r.isolated && !r.sharedArrayBuffer) out.push({ level: 'bad', text: 'Isolated but no shared memory. This Safari version blocks threads.' });
    if (r.sharedArrayBuffer && r.sharedMemoryMaxMB < 2048) out.push({ level: 'warn', text: `Safari only reserves ${r.sharedMemoryMaxMB} MB of shared memory. If the PSP build asks for more, it fails at start-up. Fix: a custom build with a smaller memory limit.` });
    if (r.sharedArrayBuffer && !r.threads) out.push({ level: 'bad', text: 'Threads can\u2019t signal each other through shared memory here.' });
    if (r.webgl2 && !r.webgl2.ok) out.push({ level: 'bad', text: 'No WebGL 2, which PPSSPP needs for graphics.' });
    if (r.webgl2 && r.webgl2.ok && !r.webgl2.colorBufferFloat) out.push({ level: 'warn', text: 'No float render targets (EXT_color_buffer_float). Some PSP graphics paths may fail.' });
    if (!r.offscreenWebGL2) out.push({ level: 'info', text: 'Workers can\u2019t draw with WebGL 2. Fine if the build draws on the main thread.' });
    if (!out.some((x) => x.level === 'bad')) out.push({ level: 'ok', text: 'This browser has every feature the PSP emulator needs. If a game crashes mid-play with no error, the phone ran out of memory; the heartbeat lines in the log show how much it was using and when.' });
    return out;
  }

  function report(r, log) {
    const lines = [
      'PhoStation PSP check', `Build: ${PS.build}`, `Date: ${new Date().toISOString()}`, `UA: ${navigator.userAgent}`, '',
      JSON.stringify(Object.assign({}, r, { verdict: undefined }), null, 1), '',
      'Verdict:', ...r.verdict.map((v) => `- [${v.level}] ${v.text}`),
      ...(r.lastSession ? ['', 'Last session: ' + r.lastSession.note] : []),
    ];
    if (log && log.length) lines.push('', 'Last emulator log:', ...log.slice(-120));
    return lines.join('\n');
  }

  PS.psplab = { run, report };
})();
