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
      added: Date.now(), played: 0, multitap: !!multitap,
    };
    l.unshift(entry);
    await saveList(l);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    return entry;
  }

  async function files(id) {
    const rec = await PS.store.get('game:' + id);
    return rec && rec.files;
  }

  async function update(id, patch) {
    const l = await list();
    const g = l.find((x) => x.id === id);
    if (!g) return;
    Object.assign(g, patch);
    l.sort((a, b) => (b.played || b.added) - (a.played || a.added));
    await saveList(l);
  }

  async function remove(id) {
    await PS.store.del('game:' + id);
    await saveList((await list()).filter((g) => g.id !== id));
  }

  PS.library = { list, add, files, update, remove };
})();
