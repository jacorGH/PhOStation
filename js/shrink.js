/* Shrink a raw disc set (.bin/.cue/.img/.iso) into .pbp, one file per disc. */
(function () {
  const PS = window.PS;
  const stripExt = (n) => n.replace(/\.[^.]+$/, '');
  const safe = (n) => n.replace(/[\\/:*?"<>|]/g, '').trim() || 'game';

  // Which discs are in this set, and can we convert them?
  function discs(files) {
    if (files.some((f) => /\.(chd|pbp|zip|7z|m3u)$/i.test(f.name))) return [];
    const cues = files.filter((f) => /\.cue$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (cues.length) return cues.map((c) => ({ cueName: c.name, label: stripExt(c.name) }));
    const raws = files.filter((f) => /\.(bin|img|iso)$/i.test(f.name));
    return raws.length === 1 ? [{ binName: raws[0].name, label: stripExt(raws[0].name) }] : [];
  }

  function convertOne(files, disc, title, outDir, onProgress) {
    return new Promise((resolve, reject) => {
      const w = new Worker('js/pbp-worker.js');
      const outName = safe(disc.label) + '.pbp';
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'progress') onProgress(d.p);
        else if (d.type === 'done') { w.terminate(); resolve({ file: d.file, opfs: d.opfs, ratio: d.ratio }); }
        else if (d.type === 'error') { w.terminate(); reject(new Error(d.message)); }
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The converter stopped unexpectedly.')); };
      w.postMessage({ files, cueName: disc.cueName, binName: disc.binName, title, outName, outDir });
    });
  }

  // Converted discs live in the private file system under a folder per game.
  async function toPbp(files, title, outDir, onProgress) {
    const list = discs(files);
    if (!list.length) throw new Error('Only .bin/.cue, .img, or raw .iso discs can be shrunk.');
    await removeDir(outDir);
    const out = [];
    let ratio = 0, opfs = true;
    for (let i = 0; i < list.length; i++) {
      const r = await convertOne(files, list[i], list.length > 1 ? `${title} (Disc ${i + 1})` : title, outDir,
        (p) => onProgress((i + p) / list.length, list.length > 1 ? `disc ${i + 1}/${list.length}` : ''));
      out.push(r.file);
      opfs = opfs && r.opfs;
      ratio += r.ratio / list.length;
    }
    if (out.length > 1) out.push(new File([out.map((f) => f.name).join('\n')], safe(title) + '.m3u', { type: 'text/plain' }));
    return { files: out, ratio, opfs };
  }

  async function removeDir(dir) {
    try { await (await navigator.storage.getDirectory()).removeEntry(dir, { recursive: true }); } catch (e) {}
  }
  async function readDir(dir, names) {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir);
    return Promise.all(names.map(async (n) => (await d.getFileHandle(n)).getFile()));
  }

  PS.shrink = { canShrink: (files) => discs(files).length > 0, toPbp, removeDir, readDir };
})();
