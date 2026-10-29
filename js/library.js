/* Game library: the disc files you pick are kept in IndexedDB on this device. */
(function () {
  const PS = window.PS;
  const stripExt = (n) => n.replace(/\.[^.]+$/, '');

  function mainName(files) {
    const m3u = files.find((f) => /\.m3u$/i.test(f.name));
    const cue = files.filter((f) => /\.cue$/i.test(f.name)).map((f) => f.name).sort()[0];
    return (m3u && m3u.name) || cue || files[0].name;
  }

  async function list() { return (await PS.store.get('games')) || []; }
  async function saveList(l) { await PS.store.set('games', l); }

  const newId = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const isDisc = (f) => /\.pbp$/i.test(f.name);

  // With opfsDir, the .pbp discs already live in the private file system; only small extras
  // (playlist, LibCrypt .sbi) are copied into the database.
  async function record(files, opfsDir) {
    if (!opfsDir) return { files };
    const extra = await Promise.all(files.filter((f) => !isDisc(f)).map(async (f) => ({ name: f.name, blob: new Blob([await f.arrayBuffer()]) })));
    return { opfs: opfsDir, names: files.filter(isDisc).map((f) => f.name), extra };
  }
  const meta = (files) => ({
    sig: files.map((f) => `${f.name}:${f.size}`).sort().join('|'),
    size: files.reduce((n, f) => n + f.size, 0),
    count: files.length,
    names: files.map((f) => f.name),
  });

  async function find(sig) { return (await list()).find((g) => g.sig === sig || g.srcSig === sig) || null; }

  // opts: { id, opfsDir, title, srcSig } — srcSig remembers the archive a game came from.
  async function add(files, multitap, opts = {}) {
    const m = meta(files);
    const l = await list();
    const existing = l.find((g) => g.sig === m.sig);
    if (existing) return existing;
    const id = opts.id || newId();
    await PS.store.set('game:' + id, await record(files, opts.opfsDir));
    const entry = {
      id, ...m, srcSig: opts.srcSig || null,
      title: (opts.title || stripExt(mainName(files))).replace(/\s*\(disc 1\)\s*/i, ' ').trim(),
      added: Date.now(), played: 0, multitap: !!multitap,
    };
    l.unshift(entry);
    await saveList(l);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    return entry;
  }

  async function files(id) {
    const rec = await PS.store.get('game:' + id);
    if (!rec) return null;
    if (rec.opfs) {
      // shrunk discs live in private files; a multi-disc playlist is kept as text here
      const discs = await PS.shrink.readDir(rec.opfs, rec.names);
      return discs.concat((rec.extra || []).map((x) => new File([x.blob || x.text], x.name)));
    }
    return rec.files;
  }

  async function update(id, patch) {
    const l = await list();
    const g = l.find((x) => x.id === id);
    if (!g) return;
    Object.assign(g, patch);
    l.sort((a, b) => (b.played || b.added) - (a.played || a.added));
    await saveList(l);
  }

  // Swap a game's files (e.g. after shrinking to .pbp) but keep its place, settings and history.
  async function replaceFiles(id, files, opfsDir) {
    await PS.store.set('game:' + id, await record(files, opfsDir));
    await update(id, meta(files));
  }

  async function remove(id) {
    const rec = await PS.store.get('game:' + id).catch(() => null);
    if (rec && rec.opfs) await PS.shrink.removeDir(rec.opfs);
    await PS.store.del('game:' + id);
    await saveList((await list()).filter((g) => g.id !== id));
  }

  PS.library = { list, add, find, newId, files, update, replaceFiles, remove };
})();
