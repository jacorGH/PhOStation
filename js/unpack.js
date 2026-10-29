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

  // Talks to disk-worker.js. Every unpacked file goes straight to storage in pieces.
  function diskClient() {
    const w = new Worker('js/disk-worker.js');
    let seq = 0;
    const pending = new Map();
    w.onmessage = (e) => {
      const d = e.data;
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (!p) return;
      if (d.error) p.rej(new Error(d.error)); else p.res(d);
    };
    w.onerror = (e) => { pending.forEach((p) => p.rej(new Error(e.message || 'Saving the unpacked game failed.'))); pending.clear(); };
    const call = (msg, transfer) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      w.postMessage({ ...msg, id }, transfer || []);
    });
    return {
      async save(dir, name, chunks) {
        const { sid } = await call({ op: 'open', dir, name });
        for await (const c of chunks) await call({ op: 'write', sid, buf: c.buffer }, [c.buffer]);
        const { file, kind } = await call({ op: 'close', sid });
        if (kind === 'opfs') file.__opfs = dir; // lives in private files under dir
        return file;
      },
      end: () => w.terminate(),
    };
  }

  // Hands an owned buffer over in 4 MB pieces (each piece is its own buffer so it can be transferred).
  function* pieces(u8) {
    const STEP = 4 * 1024 * 1024;
    for (let off = 0; off < u8.length; off += STEP) yield u8.slice(off, Math.min(u8.length, off + STEP));
  }

  async function unzip(file, dir, disk, onProgress) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((e) => !e.dir && wanted(e.name));
    const total = entries.reduce((n, e) => n + ((e._data && e._data.uncompressedSize) || 0), 0) || 1;
    let doneBytes = 0;
    const out = [];
    for (const entry of entries) {
      // Stream the entry out in 4 MB batches instead of inflating it whole.
      const chunks = (async function* () {
        const queue = [];
        let ended = false, failed = null, wake = null;
        let batch = new Uint8Array(4 * 1024 * 1024), fill = 0;
        const h = entry.internalStream('uint8array');
        h.on('data', (c) => {
          doneBytes += c.length;
          let off = 0;
          while (off < c.length) {
            const k = Math.min(batch.length - fill, c.length - off);
            batch.set(c.subarray(off, off + k), fill);
            fill += k; off += k;
            if (fill === batch.length) { queue.push(batch); batch = new Uint8Array(batch.length); fill = 0; h.pause(); }
          }
          if (wake) { wake(); wake = null; }
        });
        h.on('end', () => { if (fill) queue.push(batch.slice(0, fill)); ended = true; if (wake) { wake(); wake = null; } });
        h.on('error', (e) => { failed = e; if (wake) { wake(); wake = null; } });
        h.resume();
        while (true) {
          if (failed) throw failed;
          if (queue.length) { yield queue.shift(); onProgress(Math.min(1, doneBytes / total)); if (!queue.length && !ended) h.resume(); continue; }
          if (ended) return;
          await new Promise((r) => (wake = r));
        }
      })();
      out.push(await disk.save(dir, baseName(entry.name), chunks));
    }
    return out;
  }

  let rarWasm = null;
  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('The unpacker couldn\u2019t be downloaded. Check the connection.');
    return r.text();
  }

  // Prepended to the extractors: hand finished files over without a copy when the data owns its buffer.
  const TRANSFER = `(function () {
    var post = self.postMessage.bind(self);
    self.postMessage = function (m, t) {
      var d = m && m.t === 2 && m.data;
      if (d && d.buffer && d.byteOffset === 0 && d.byteLength === d.buffer.byteLength) { try { return post(m, [d.buffer]); } catch (e) {} }
      return post(m, t);
    };
  })();\n`;

  async function workerFor(k) {
    if (k === '7z') return new Blob([TRANSFER, await fetchText(BASE + 'extract7z.js')], { type: 'text/javascript' });
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
    return new Blob([TRANSFER, script], { type: 'text/javascript' });
  }

  async function viaWorker(file, k, dir, disk, onProgress) {
    const url = URL.createObjectURL(await workerFor(k));
    const data = await file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const w = new Worker(url);
      const out = [];
      let saving = Promise.resolve(), finished = false;
      const stop = () => { w.terminate(); URL.revokeObjectURL(url); };
      const fail = (msg) => { if (finished) return; finished = true; stop(); reject(new Error(msg)); };
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.t === 4 && d.total) onProgress(Math.min(1, d.current / d.total));
        else if (d.t === 2 && d.data && wanted(d.file)) {
          // Write each file to storage as soon as it arrives, then drop it from memory.
          let bytes = d.data instanceof Uint8Array ? d.data : new Uint8Array(d.data);
          const name = baseName(d.file);
          saving = saving.then(async () => {
            const it = pieces(bytes);
            bytes = null;
            out.push(await disk.save(dir, name, it));
          }).catch((err) => fail('Couldn\u2019t save the unpacked game: ' + err.message));
        } else if (d.t === 1) {
          stop(); // frees the archive and the extractor's memory right away
          saving.then(() => { if (!finished) { finished = true; resolve(out); } });
        } else if (d.t === 9) fail('The archive couldn\u2019t be unpacked: ' + d.error);
      };
      w.onerror = (e) => fail('The archive couldn\u2019t be unpacked' + (e.message ? ': ' + e.message : '. It may be too large for this phone.'));
      w.postMessage(new Uint8Array(data), [data]); // same shape EmulatorJS sends
    });
  }

  // dir: storage folder the unpacked files go into.
  async function extract(file, dir, onProgress = () => {}) {
    const k = await kind(file);
    if (!k) throw new Error('This file isn\u2019t a .zip, .7z or .rar archive.');
    const disk = diskClient();
    try {
      const files = k === 'zip' ? await unzip(file, dir, disk, onProgress) : await viaWorker(file, k, dir, disk, onProgress);
      if (!files.some((f) => /\.(bin|iso|img|chd|pbp|mdf)$/i.test(f.name))) throw new Error('No PS1 disc image was found in this archive.');
      return files;
    } finally {
      disk.end();
    }
  }

  PS.unpack = { kind, extract, isArchiveName: (n) => /\.(zip|7z|rar)$/i.test(n) };
})();
