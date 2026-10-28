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

  async function add(files, multitap) {
    const sig = files.map((f) => `${f.name}:${f.size}`).sort().join('|');
    const l = await list();
    const existing = l.find((g) => g.sig === sig);
    if (existing) return existing;
    const id = 'g' + Date.now().toString(36);
    // Files are stored as-is; the browser keeps them on disk, not in memory.
    await PS.store.set('game:' + id, { files });
    const entry = {
      id, sig,
      title: stripExt(mainName(files)).replace(/\s*\(disc 1\)\s*/i, ' ').trim(),
      size: files.reduce((n, f) => n + f.size, 0),
      count: files.length,
      names: files.map((f) => f.name),
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
      return discs.concat((rec.extra || []).map((x) => new File([x.text], x.name, { type: 'text/plain' })));
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
  // With opfsDir, the files already live in the private file system and only their names are kept.
  async function replaceFiles(id, files, opfsDir) {
    const m3u = files.filter((f) => /\.m3u$/i.test(f.name));
    const discs = files.filter((f) => !/\.m3u$/i.test(f.name));
    const extra = await Promise.all(m3u.map(async (f) => ({ name: f.name, text: await f.text() })));
    await PS.store.set('game:' + id, opfsDir ? { opfs: opfsDir, names: discs.map((f) => f.name), extra } : { files });
    await update(id, {
      sig: files.map((f) => `${f.name}:${f.size}`).sort().join('|'),
      size: files.reduce((n, f) => n + f.size, 0),
      count: files.length,
      names: files.map((f) => f.name),
    });
  }

  async function remove(id) {
    const rec = await PS.store.get('game:' + id).catch(() => null);
    if (rec && rec.opfs) await PS.shrink.removeDir(rec.opfs);
    await PS.store.del('game:' + id);
    await saveList((await list()).filter((g) => g.id !== id));
  }

  PS.library = { list, add, files, update, replaceFiles, remove };
})();
