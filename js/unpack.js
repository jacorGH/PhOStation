/* Unpack .zip / .7z / .rar once, when a game is added, so it never has to be unpacked at launch.
   .zip uses JSZip. .7z and .rar use the same extractors EmulatorJS ships on its CDN. */
(function () {
  const PS = window.PS;
  const BASE = 'https://cdn.emulatorjs.org/stable/data/compression/';
  const KEEP = /\.(bin|cue|iso|img|chd|pbp|m3u|sbi|ccd|sub|mdf|mds|toc)$/i;

  async function kind(file) {
    const h = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04) return 'zip';
    if (h[0] === 0x37 && h[1] === 0x7a && h[2] === 0xbc && h[3] === 0xaf) return '7z';
    if (h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21) return 'rar';
    return null;
  }

  const baseName = (p) => p.split(/[\\/]/).pop();
  const wanted = (p) => {
    const n = baseName(p);
    return n && !p.includes('__MACOSX') && !n.startsWith('._') && KEEP.test(n);
  };

  async function unzip(file, onProgress) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((e) => !e.dir && wanted(e.name));
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const blob = await entries[i].async('blob', (m) => onProgress((i + m.percent / 100) / entries.length));
      out.push(new File([blob], baseName(entries[i].name)));
    }
    return out;
  }

  let rarWasm = null;
  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('The unpacker couldn\u2019t be downloaded. Check the connection.');
    return r.text();
  }

  async function workerFor(k) {
    if (k === '7z') return new Blob([await fetchText(BASE + 'extract7z.js')], { type: 'text/javascript' });
    // libunrar is an Emscripten build: point it at its .wasm, and start once both the runtime and the data are ready.
    if (!rarWasm) {
      const r = await fetch(BASE + 'libunrar.wasm');
      if (!r.ok) throw new Error('The .rar unpacker couldn\u2019t be downloaded.');
      rarWasm = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'application/wasm' }));
    }
    const lib = await fetchText(BASE + 'libunrar.js');
    const script = `
      var archive = null, ready = false, done = false;
      function go() {
        if (!ready || !archive || done) return;
        done = true;
        try {
          var tree = readRARContent([archive], null, function (name, size, progress) {
            postMessage({ t: 4, current: progress, total: size, name: name });
          });
          (function walk(e) {
            if (!e) return;
            if (e.type === 'file') postMessage({ t: 2, file: e.fullFileName, data: e.fileContent });
            else if (e.type === 'dir') Object.keys(e.ls).forEach(function (k) { walk(e.ls[k]); });
          })(tree);
          postMessage({ t: 1 });
        } catch (err) { postMessage({ t: 9, error: String((err && err.message) || err) }); }
      }
      var Module = {
        locateFile: function () { return '${rarWasm}'; },
        monitorRunDependencies: function (left) { if (left === 0) { ready = true; setTimeout(go, 30); } },
        onRuntimeInitialized: function () { ready = true; setTimeout(go, 30); }
      };
      ${lib}
      onmessage = function (e) { archive = { name: 'game.rar', content: new Uint8Array(e.data) }; go(); };
    `;
    return new Blob([script], { type: 'text/javascript' });
  }

  async function viaWorker(file, k, onProgress) {
    const url = URL.createObjectURL(await workerFor(k));
    const data = await file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const w = new Worker(url);
      const out = [];
      const fail = (msg) => { w.terminate(); URL.revokeObjectURL(url); reject(new Error(msg)); };
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.t === 4 && d.total) onProgress(Math.min(1, d.current / d.total));
        else if (d.t === 2 && d.data && wanted(d.file)) out.push(new File([d.data], baseName(d.file)));
        else if (d.t === 1) { w.terminate(); URL.revokeObjectURL(url); resolve(out); }
        else if (d.t === 9) fail('The archive couldn\u2019t be unpacked: ' + d.error);
      };
      w.onerror = (e) => fail('The archive couldn\u2019t be unpacked' + (e.message ? ': ' + e.message : '. It may be too large for this phone.'));
      w.postMessage(new Uint8Array(data), [data]); // same shape EmulatorJS sends
    });
  }

  async function extract(file, onProgress = () => {}) {
    const k = await kind(file);
    if (!k) throw new Error('This file isn\u2019t a .zip, .7z or .rar archive.');
    const files = k === 'zip' ? await unzip(file, onProgress) : await viaWorker(file, k, onProgress);
    if (!files.some((f) => /\.(bin|iso|img|chd|pbp|mdf)$/i.test(f.name))) throw new Error('No PS1 disc image was found in this archive.');
    return files;
  }

  PS.unpack = { kind, extract, isArchiveName: (n) => /\.(zip|7z|rar)$/i.test(n) };
})();
