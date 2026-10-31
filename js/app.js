(function () {
  const PS = window.PS;
  const P = PS.prefs;
  const esc = PS.esc;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const S = {
    role: null, net: null, code: null, files: null, bios: null, multitap: false,
    myPort: null, myRole: 'player', view: 'full', lockViews: true, localFull: false,
    roster: [], hostState: null, running: false, ejsUi: false, want: 'player',
    skinId: P.skin || 'default', ff: false, gotStream: false, gameId: null,
  };

  // ---------- helpers ----------
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), ms);
  }
  function show(id) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
    document.body.dataset.view = id;
  }
  function makeCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    return [...crypto.getRandomValues(new Uint8Array(5))].map((x) => A[x % A.length]).join('');
  }
  const myName = () => (P.name || '').trim() || (S.role === 'host' ? 'Host' : 'Player');
  const inviteUrl = () => `${location.origin}${location.pathname}?room=${S.code}`;
  function setWaiting(msg) {
    const w = $('#waiting');
    w.hidden = !msg;
    if (msg) $('p', w).textContent = msg;
  }
  async function share() {
    let url = inviteUrl();
    const relay = PS.ice.shareable();
    if (relay) { try { url += '&r=' + (await PS.direct.packRelay(relay)); } catch (e) {} }
    try {
      if (navigator.share) await navigator.share({ title: 'PhoStation', text: `Join my PS1 room: ${S.code}`, url });
      else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    } catch (e) { /* share sheet dismissed */ }
  }

  // ---------- home ----------
  $('#nameInput').value = P.name || '';
  $('#nameInput').addEventListener('input', (e) => (P.name = e.target.value.trim()));
  $('#goHost').onclick = startHosting;

  // One-tap "Continue" for the last game played on this phone.
  async function renderContinue() {
    const btn = $('#continueBtn');
    const g = (await PS.library.list().catch(() => [])).find((x) => x.played);
    if (!g) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.dataset.id = g.id;
    $('#continueTitle').textContent = `Continue ${g.title}`;
    const info = g.stateKey ? await PS.emu.stateInfo('auto', g.stateKey).catch(() => null) : null;
    $('#continueSub').textContent = info ? `Resumes from ${ago(info.at)}` : 'Opens your room and starts the game';
    $('#continueThumb').style.backgroundImage = info && info.thumb ? `url(${info.thumb})` : '';
    $('#continueThumb').hidden = !(info && info.thumb);
  }
  $('#continueBtn').onclick = async () => {
    const id = $('#continueBtn').dataset.id;
    await startHosting();
    await selectGame(id);
    if (S.gameId !== id) return;
    S.autoResume = true;
    $('#startBtn').click();
  };
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  renderContinue();
  // Rejoin the last room (within a few hours): same device, same player slot.
  if (P.lastRoom && Date.now() - P.lastRoom.at < 6 * 3600e3) {
    $('#rejoinBtn').hidden = false;
    $('#rejoinTitle').textContent = `Rejoin room ${P.lastRoom.code}`;
  }
  $('#rejoinBtn').onclick = () => {
    $('#codeInput').value = P.lastRoom.code;
    S.want = P.lastRoom.want || 'player';
    $$('#wantSeg button').forEach((x) => { x.classList.toggle('on', x.dataset.want === S.want); x.setAttribute('aria-checked', x.dataset.want === S.want); });
    $('#joinBtn').click();
  };
  $('#goJoin').onclick = () => { show('join'); setTimeout(() => $('#codeInput').focus(), 50); };
  $('#goSettings').onclick = () => { renderSettings(); show('settings'); };
  $$('[data-back]').forEach((b) => (b.onclick = () => {
    if (S.role === 'host' && S.net && !S.running) { S.net.destroy(); S.net = null; S.role = null; }
    show('home');
  }));
  // If the last load never finished, the page was reloaded mid-load (on iPhone: out of memory).
  try {
    const last = JSON.parse(localStorage.getItem('phostation.loading') || 'null');
    localStorage.removeItem('phostation.loading');
    if (last && Date.now() - last.at < 30 * 60e3) {
      const where = { core: 'while downloading the emulator', disc: 'while loading the disc', boot: 'while booting the disc' }[last.stage] || 'while loading';
      const msg = `${last.game || 'The game'} stopped ${where} and the page restarted. `
        + (last.stage === 'core'
          ? 'Check the connection and try again.'
          : 'iPhone does this when a game needs more memory than Safari allows. Close other tabs and try again. A .chd or .pbp copy of the disc uses much less memory than .bin or .iso.');
      $$('[data-crash]').forEach((el) => { el.textContent = msg; el.hidden = false; });
    }
  } catch (e) {}

  try {
    const add = JSON.parse(localStorage.getItem('phostation.adding') || 'null');
    localStorage.removeItem('phostation.adding');
    if (add && Date.now() - add.at < 30 * 60e3) {
      const msg = add.stage === 'unpack'
        ? `Unpacking ${add.game} stopped at ${add.p}% and the page restarted because the phone ran out of memory. The archive has to fit in memory while it unpacks. Unpack it on a computer, or tap a .zip in the Files app to expand it, then add the .bin and .cue files.`
        : `Compressing ${add.game} stopped at ${add.p}% and the page restarted. Close other apps and Safari tabs, then add it again. If it keeps happening, add the .bin and .cue files without shrinking.`;
      $$('[data-crash]').forEach((el) => { el.textContent = msg; el.hidden = false; });
    }
  } catch (e) {}

  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) { $('#codeInput').value = qRoom.toUpperCase().slice(0, 5); show('join'); }

  // ---------- host setup ----------
  async function freshRelay() {
    try { await PS.ice.refresh(); } catch (e) { toast('Relay: ' + e.message, 5000); }
  }
  async function startHosting() {
    S.role = 'host';
    show('hostSetup');
    loadSavedBios();
    renderLibrary();
    await freshRelay();
    try { openRoom(); }
    catch (e) { setHostStatus('The lobby library didn’t load, so friends can’t join. You can still play solo.'); }
  }
  function openRoom() {
    S.code = makeCode();
    $('#hostCode').innerHTML = [...S.code].map((c) => `<span>${c}</span>`).join('');
    setHostStatus('Opening room…');
    S.net = PS.net.createHost(S.code, myName(), hostHandlers);
  }
  function setHostStatus(msg, ok) {
    const el = $('#hostStatus');
    el.textContent = msg;
    el.classList.toggle('ok', !!ok);
  }
  const hostHandlers = {
    status(s) {
      if (s === 'ready') {
        if (S.running) toast('Lobby connection restored');
        else setHostStatus('Room is open. Friends can join now, even before you start.', true);
      } else if (s === 'taken') {
        if (!S.running) { S.net.destroy(); openRoom(); }
      } else if (s === 'reconnecting') {
        if (S.running) toast('Lobby connection dropped. Players already in stay connected.');
        else setHostStatus('Can\u2019t reach the lobby, so room codes may not work. Direct invites still do.');
      }
    },
    roster: onRoster,
    toast,
    stats(roster) {
      const guests = roster.filter((m) => !m.isHost && m.connected);
      const worst = guests.reduce((w, m) => (m.rtt != null && m.rtt > w ? m.rtt : w), 0);
      setStat(guests.length ? `${guests.length} connected${worst ? `, ${worst} ms` : ''}` : 'Solo', guests.length ? worst : null);
      S.roster = roster;
      if (sheetOpen()) refreshPlayers();
    },
  };
  $('#shareBtn').onclick = share;

  // ---------- games list ----------
  const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');
  function fmtWhen(t) {
    if (!t) return 'not played yet';
    const d = Math.floor((Date.now() - t) / 864e5);
    return d <= 0 ? 'played today' : d === 1 ? 'played yesterday' : `played ${d} days ago`;
  }
  async function renderLibrary() {
    let games = [];
    try { games = await PS.library.list(); } catch (e) {}
    $('#library').hidden = !games.length;
    $('#pickTitle').textContent = games.length ? 'Add another game' : 'Choose a game';
    $('#libList').innerHTML = games.map((g) => {
      const named = (g.names || []).map((name) => ({ name }));
      const shrinkable = !g.names || PS.shrink.canShrink(named);
      const isPbp = named.some((f) => /\.pbp$/i.test(f.name));
      const busy = S.shrinking === g.id;
      return `
      <div class="game ${g.id === S.gameId ? 'sel' : ''} ${busy ? 'busy' : ''}" data-gid="${g.id}">
        <button data-pick="${g.id}" ${busy ? 'disabled' : ''}><b>${esc(g.title)}</b><small>${fmtSize(g.size)}${isPbp ? ' .pbp' : ''}, ${fmtWhen(g.played)}</small></button>
        ${shrinkable && !isPbp ? `<button class="act" data-shrink="${g.id}" ${S.shrinking ? 'disabled' : ''}>Shrink</button>` : ''}
        ${isPbp ? `<button class="act" data-save="${g.id}">Save</button>` : ''}
        <button class="del" data-del="${g.id}" aria-label="Remove ${esc(g.title)}" ${busy ? 'disabled' : ''}>×</button>
      </div>`;
    }).join('');
  }
  $('#libList').addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    const del = e.target.closest('[data-del]');
    const shrink = e.target.closest('[data-shrink]');
    const save = e.target.closest('[data-save]');
    if (shrink) return shrinkGame(shrink.dataset.shrink);
    if (save) return saveGame(save.dataset.save);
    if (del) {
      if (!confirm('Remove this game from the list? The file on your phone isn\u2019t touched.')) return;
      await PS.library.remove(del.dataset.del);
      if (S.gameId === del.dataset.del) { S.gameId = null; S.files = null; $('#startBtn').disabled = true; }
      renderLibrary();
      return;
    }
    if (pick) await selectGame(pick.dataset.pick);
  });

  async function shrinkGame(id) {
    if (S.shrinking) return;
    const files = await PS.library.files(id).catch(() => null);
    const g = (await PS.library.list()).find((x) => x.id === id);
    if (!files || !g) { toast('That game\u2019s files are missing. Add it again.'); return; }
    if (!PS.shrink.canShrink(files)) { toast('Only .bin/.cue, .img, or raw .iso discs can be shrunk. This one is already compact.'); return; }
    S.shrinking = id;
    await renderLibrary();
    requestWakeLock();
    const label = $(`[data-gid="${id}"] small`);
    try {
      const r = await PS.shrink.toPbp(files, g.title, 'pbp-' + id, (p, extra) => {
        if (label) label.textContent = `Shrinking ${Math.round(p * 100)}%${extra ? ', ' + extra : ''}. Keep this screen open.`;
      });
      await PS.library.replaceFiles(id, r.files, r.opfs ? 'pbp-' + id : null);
      toast(`Shrunk to .pbp, ${Math.round(r.ratio * 100)}% of the original size`, 4000);
      if (S.gameId === id) { S.shrinking = null; await selectGame(id); }
    } catch (err) {
      toast(err.message || 'The disc couldn\u2019t be shrunk.', 6000);
    }
    S.shrinking = null;
    renderLibrary();
  }

  // Hand the .pbp to the share sheet (Save to Files) or download it.
  async function saveGame(id) {
    const files = await PS.library.files(id).catch(() => null);
    if (files) await shareFiles(files);
  }

  async function selectGame(id) {
    let files = await PS.library.files(id).catch(() => null);
    if (!files || !files.length) { toast('That game\u2019s files are missing. Add it again.'); return; }
    // Games added as archives by an older version: unpack them once now instead of at every launch.
    if (files.length === 1 && PS.unpack.isArchiveName(files[0].name)) {
      if (S.busy) return;
      $('#gamePick').classList.add('set');
      try {
        await addArchive(files[0], (t) => ($('#gameName').textContent = t), id);
        files = await PS.library.files(id);
        toast('Unpacked. It loads quickly from now on.');
      } catch (err) {
        toast(err.message || 'That game couldn\u2019t be unpacked.', 6000);
        $('#gameName').textContent = PICK_HINT;
        $('#gamePick').classList.remove('set');
        return;
      }
    }
    const g = (await PS.library.list()).find((x) => x.id === id);
    S.gameId = id;
    S.files = files;
    if (g) {
      $('#multitapChk').checked = !!g.multitap;
      setPerfChoice(g.perf || P.perf || 'balanced');
      if (!g.names) PS.library.update(id, { names: files.map((f) => f.name) }).catch(() => {});
    }
    $('#gamePick').classList.remove('set');
    $('#gameName').textContent = PICK_HINT;
    $('#startBtn').disabled = false;
    renderLibrary();
  }

  const PICK_HINT = '.chd, .pbp, .bin + .cue, .iso, or a .zip, .7z or .rar. It stays in your games list.';
  // Adds picked files to the games list (unpacking/compressing archives). Throws on failure.
  async function addGameFiles(fs, status) {
    const archive = fs.length === 1 && (await PS.unpack.kind(fs[0]));
    if (archive) return addArchive(fs[0], status);
    status('Saving to your games…');
    return PS.library.add(fs, $('#multitapChk').checked);
  }
  $('#gameFile').onchange = async (e) => {
    const fs = [...e.target.files];
    e.target.value = '';
    if (!fs.length || S.busy) return;
    if (fs.length === 1 && /\.cue$/i.test(fs[0].name)) { toast('Select the .cue together with its .bin file(s)', 4000); return; }
    const status = (t) => ($('#gameName').textContent = t);
    $('#gamePick').classList.add('set');
    try {
      const entry = await addGameFiles(fs, status);
      await selectGame(entry.id);
      toast(`Saved \u201c${entry.title}\u201d to your games`);
    } catch (err) {
      if (err.archive) {
        toast(err.message, 6000);
        status(PICK_HINT);
        $('#gamePick').classList.remove('set');
        return;
      }
      // Storage full or blocked: still let them play this session.
      S.gameId = null;
      S.files = fs;
      $('#startBtn').disabled = false;
      status(`${fs[0].name}${fs.length > 1 ? ` + ${fs.length - 1} more` : ''} (not saved, phone storage is full)`);
    }
  };

  // Progress breadcrumb for adding a game: if the phone kills the page, the next launch says where.
  let crumbAt = 0;
  function addCrumb(stage, game, p) {
    const now = Date.now();
    if (stage && now - crumbAt < 1500 && p < 1) return;
    crumbAt = now;
    try {
      if (stage) localStorage.setItem('phostation.adding', JSON.stringify({ stage, game, p: Math.round(p * 100), at: now }));
      else localStorage.removeItem('phostation.adding');
    } catch (e) {}
  }

  // Unpack once, then compress raw discs to .pbp so the game is small and quick to load from then on.
  // Everything is written to storage as it's produced, so memory stays low.
  // replaceId: convert an archive that's already in the games list, keeping its place and settings.
  async function addArchive(file, status, replaceId) {
    const srcSig = `archive:${file.name}:${file.size}`;
    if (!replaceId) {
      const known = await PS.library.find(srcSig);
      if (known) return known;
    }
    const title = file.name.replace(/\.(zip|7z|rar)$/i, '').replace(/\s*\(disc 1\)\s*/i, ' ').trim();
    const multitap = $('#multitapChk').checked;
    const id = replaceId || PS.library.newId();
    const rawDir = 'g-' + id, pbpDir = 'pbp-' + id;
    const save = (files, dir) => replaceId
      ? PS.library.replaceFiles(id, files, dir).then(async () => (await PS.library.list()).find((g) => g.id === id))
      : PS.library.add(files, multitap, { id, opfsDir: dir, title, srcSig });
    S.busy = true;
    requestWakeLock();
    try {
      let files;
      status('Unpacking…');
      addCrumb('unpack', title, 0);
      try {
        files = await PS.unpack.extract(file, rawDir, (p) => {
          addCrumb('unpack', title, p);
          status(`Unpacking ${Math.round(p * 100)}%. Keep this screen open.`);
        });
      } catch (err) { err.archive = true; throw err; }
      const rawOnDisk = files.every((f) => f.__opfs === rawDir);

      if (PS.shrink.canShrink(files)) {
        try {
          addCrumb('compress', title, 0);
          const r = await PS.shrink.toPbp(files, title, pbpDir, (p, extra) => {
            addCrumb('compress', title, p);
            status(`Compressing ${Math.round(p * 100)}%${extra ? ', ' + extra : ''}. Keep this screen open.`);
          });
          status('Saving to your games…');
          const entry = await save(r.files, r.opfs ? pbpDir : null);
          await PS.shrink.removeDir(rawDir);                // unpacked copy no longer needed
          if (!r.opfs) await PS.shrink.removeDir(pbpDir);    // temporary chunks, now copied into the games list
          return entry;
        } catch (err) {
          await PS.shrink.removeDir(pbpDir);
          toast('Couldn\u2019t compress it, so it\u2019s saved unpacked instead.', 4000);
        }
      }
      status('Saving to your games…');
      const entry = await save(files, rawOnDisk ? rawDir : null);
      if (!rawOnDisk) await PS.shrink.removeDir(rawDir);
      return entry;
    } catch (err) {
      await PS.shrink.removeDir(rawDir);
      throw err;
    } finally {
      addCrumb(null);
      S.busy = false;
    }
  }

  async function loadSavedBios() {
    try {
      const rec = await PS.store.get('bios');
      if (rec && rec.blob) setBios(new File([rec.blob], rec.name));
    } catch (e) {}
  }
  function setBios(f) {
    S.bios = f;
    $('#biosName').textContent = f ? `${f.name} (remembered)` : 'Optional. The built-in BIOS runs most games.';
    $('#biosClear').hidden = !f;
    $('#biosPick').classList.toggle('set', !!f);
  }
  $('#biosFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setBios(f);
    try { await PS.store.set('bios', { name: f.name, blob: new Blob([await f.arrayBuffer()]) }); } catch (err) {}
  };
  $('#biosClear').onclick = async () => { setBios(null); try { await PS.store.del('bios'); } catch (e) {} };

  // ---------- speed ----------
  const PERF_NOTES = {
    quality: 'Draws every frame with full sound effects. Needs a fast phone.',
    balanced: 'Skips drawing a frame only when the phone falls behind.',
    fast: 'Also lightens sound effects and slightly underclocks the console.',
    turbo: 'Draws every other frame and underclocks more. A few games may run slower inside.',
  };
  S.perf = P.perf || 'balanced';
  function setPerfChoice(v) {
    S.perf = v;
    $$('#perfSeg button').forEach((b) => b.classList.toggle('on', b.dataset.perf === v));
    $('#perfNote').textContent = PERF_NOTES[v];
  }
  $$('#perfSeg button').forEach((b) => (b.onclick = () => { setPerfChoice(b.dataset.perf); P.perf = b.dataset.perf; }));
  setPerfChoice(S.perf);

  $('#startBtn').onclick = async () => {
    S.multitap = $('#multitapChk').checked;
    if (S.gameId) PS.library.update(S.gameId, { played: Date.now(), multitap: S.multitap, perf: S.perf }).catch(() => {});
    if (!S.net) { S.net = soloNet(); S.myPort = 0; }
    S.net.setMaxPorts(S.multitap ? 4 : 2);
    enterPlay();
    setWaiting('Preparing the disc…');
    try {
      await PS.emu.load({
        files: S.files, bios: S.bios, multitap: S.multitap, perf: S.perf,
        handlers: { progress: setWaiting, started: onGameStarted },
      });
    } catch (err) {
      setWaiting(err.message || 'The game could not be loaded.');
    }
  };
  // Stand-in when PeerJS is unavailable: the game still runs locally on P1.
  function soloNet() {
    return {
      voiceOn: false, setMaxPorts() {}, setRunning() {}, setPaused() {}, destroy() {}, unlockAudio() {}, roster: () => [],
      voiceStart() { throw new Error('Voice needs the lobby connection.'); }, voiceStop() {},
    };
  }
  async function onGameStarted() {
    S.running = true;
    setWaiting(null);
    applyView();
    // Video is only captured and encoded once a friend is actually connected.
    if (S.streamSet) {
      S.net.swapStream(() => PS.emu.captureStream());
      S.net.notify && S.net.notify(`Now playing ${PS.emu.title}`);
    } else {
      S.net.setRunning(() => PS.emu.captureStream());
      S.streamSet = true;
    }
    S.ff = false;
    if (S.gameId) {
      PS.library.update(S.gameId, { stateKey: PS.emu.gameName }).catch(() => {});
      const g = (await PS.library.list().catch(() => [])).find((x) => x.id === S.gameId);
      S.cheats = (g && g.cheats) || [];
    } else S.cheats = S.cheats || [];
    if (S.cheats.some((c) => c.on)) setTimeout(() => PS.emu.applyCheats(S.cheats), 1500);
    offerResume();
    startAutosave();
    // iPhone Low Power Mode limits the screen to 30 fps, and the emulator runs once per screen
    // refresh, so games play at half speed. Switch the emulator to its own 60 fps timer.
    setTimeout(async () => {
      const fps = await PS.emu.measureFps(2000);
      if (fps >= 45) return;
      S.uncapped = PS.emu.setUncapped(true);
      toast(S.uncapped
        ? 'Your screen is limited to 30 fps (Low Power Mode?). The game now runs on its own 60 fps timer.'
        : 'Your screen is limited to 30 fps, which halves game speed. Turn off Low Power Mode in Settings, Battery.', 7000);
    }, 4000);
  }

  // ---------- change game without ending the session ----------
  async function swapGameMenu() {
    const games = await PS.library.list().catch(() => []);
    openModal(`<h2>Change game</h2>
      <p class="note">Everyone stays connected and keeps their port. Your progress in ${esc(PS.emu.title)} is saved first.</p>
      <div class="swaplist">${games.map((g) => `<button data-swap="${g.id}" class="${g.id === S.gameId ? 'cur' : ''}" ${g.id === S.gameId ? 'disabled' : ''}>
        <b>${esc(g.title)}</b><small>${g.id === S.gameId ? 'Playing now' : fmtWhen(g.played).replace(/^./, (c) => c.toUpperCase())}</small></button>`).join('')}</div>
      <label class="ghost wide filebtn">Add another game<input type="file" id="swapFile" multiple></label>
      <p class="dstatus" id="swapStatus"></p>`);
    $('#modalBody').onclick = (e) => {
      const b = e.target.closest('[data-swap]');
      if (b) doSwap(b.dataset.swap);
    };
    $('#swapFile').onchange = async (e) => {
      const fs = [...e.target.files];
      e.target.value = '';
      if (!fs.length || S.busy) return;
      const status = (t) => { const el = $('#swapStatus'); if (el) el.textContent = t; };
      try { const entry = await addGameFiles(fs, status); doSwap(entry.id); }
      catch (err) { status(err.message || 'That game couldn\u2019t be added.'); }
    };
  }

  async function doSwap(id) {
    if (S.swapping || id === S.gameId) return;
    S.swapping = true;
    closeModal();
    closeSheet();
    try {
      setWaiting('Saving your progress…');
      try { await PS.emu.saveState('auto'); } catch (e) {}
      hideResume();
      await selectGame(id); // loads files, unpacks older packed games, restores per-game settings
      if (S.gameId !== id) throw new Error('That game couldn\u2019t be opened.');
      S.multitap = $('#multitapChk').checked;
      S.net.setMaxPorts(S.multitap ? 4 : 2);
      PS.library.update(id, { played: Date.now(), multitap: S.multitap, perf: S.perf }).catch(() => {});
      if (PS.emu.paused) { PS.emu.setPaused(false); S.net.setPaused && S.net.setPaused(false); $('#pausedBanner').hidden = true; }
      S.running = false;
      S.net.notify && S.net.notify('The host is changing the game…');
      setWaiting('Loading the new game…');
      await PS.emu.load({
        files: S.files, bios: S.bios, multitap: S.multitap, perf: S.perf,
        handlers: { progress: setWaiting, started: onGameStarted },
      });
    } catch (err) {
      setWaiting(null);
      toast(err.message || 'The game couldn\u2019t be changed.', 5000);
    }
    S.swapping = false;
  }

  // ---------- resume & autosave ----------
  async function offerResume() {
    const info = await PS.emu.stateInfo('auto').catch(() => null);
    if (!info) return;
    if (S.autoResume) {
      S.autoResume = false;
      setTimeout(async () => { if (await PS.emu.loadState('auto')) toast(`Continued from ${ago(info.at)}`); }, 600);
      return;
    }
    S.resumePending = true;
    $('#resumeWhen').textContent = `Saved automatically ${ago(info.at)}`;
    $('#resumeThumb').style.backgroundImage = info.thumb ? `url(${info.thumb})` : '';
    $('#resumeBar').hidden = false;
    clearTimeout(S.resumeT);
    S.resumeT = setTimeout(hideResume, 20000);
  }
  function hideResume() { $('#resumeBar').hidden = true; S.resumePending = false; }
  $('#resumeYes').onclick = async () => {
    hideResume();
    toast((await PS.emu.loadState('auto')) ? 'Continued' : 'That save couldn’t be loaded');
  };
  $('#resumeNo').onclick = hideResume;

  // Saves every 3 minutes and whenever the app is sent to the background, so a closed tab
  // or a crash never costs more than a few minutes.
  let autosaveOn = false;
  async function autosave() {
    if (S.role !== 'host' || !S.running || S.resumePending || PS.emu.paused && S.autoPaused) return;
    try { await PS.emu.saveState('auto'); } catch (e) {}
  }
  function startAutosave() {
    if (autosaveOn) return;
    autosaveOn = true;
    setInterval(autosave, 180000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave(); });
    addEventListener('pagehide', autosave);
  }

  // ---------- pause ----------
  function setPause(on) {
    if (S.role !== 'host' || !S.running) return;
    PS.emu.setPaused(on);
    S.net.setPaused && S.net.setPaused(on);
    $('#pausedBanner').hidden = !on;
  }
  const guestsConnected = () => S.roster.some((m) => !m.isHost && m.connected);

  // ---------- screenshots & sharing ----------
  async function shareFiles(files) {
    try {
      if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  }
  async function takeScreenshot() {
    let blob = null;
    if (S.role === 'host') blob = await PS.emu.screenshot();
    else {
      const v = $('#remote');
      if (v.videoWidth) {
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      }
    }
    if (!blob) { toast('Nothing to capture yet'); return; }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    await shareFiles([new File([blob], `${PS.emu.title || 'PhoStation'} ${stamp}.png`, { type: 'image/png' })]);
  }

  // ---------- display & controller look ----------
  function applyLook() {
    const play = $('#play');
    play.dataset.filter = P.filter || 'sharp';
    PS.emu.setFilter(P.filter || 'sharp');
    const pad = $('#pad');
    pad.style.setProperty('--pad-scale', P.padSize || 1);
    pad.style.setProperty('--pad-alpha', P.padAlpha == null ? 1 : P.padAlpha);
    $('#skinBg').style.opacity = P.padAlpha == null ? 1 : P.padAlpha;
    PS.controls.setTurbo(P.turbo || 0);
  }
  applyLook();

  // ---------- modal ----------
  function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; }
  function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
  $('#modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
    catch (e) { toast('Couldn\u2019t copy. Press and hold the code box to copy it.'); }
  }

  // ---------- connection check ----------
  document.addEventListener('click', (e) => { if (e.target.closest('[data-check]')) runCheck(); });
  async function runCheck() {
    const rows = [
      ['lobby', 'Lobby server', 'Needed for room codes'],
      ['nat', 'Peer-to-peer', 'Can this network punch through to friends?'],
      ['turn', 'Your relay', hasRelay() ? 'Fallback when direct fails' : 'Not set up yet'],
    ];
    openModal(`<h2>Connection check</h2><p class="note">Takes about 10 seconds. Run it on both phones to compare.</p>
      <div class="checks">${rows.map(([k, t, d]) => `<div class="check" data-k="${k}" data-s="${k === 'turn' && !hasRelay() ? 'skip' : 'run'}"><span class="ic"></span><span>${t}<small>${d}</small></span></div>`).join('')}</div>
      <div id="checkOut"></div>`);
    const set = (k, st, detail) => {
      const el = $(`.check[data-k="${k}"]`);
      if (!el) return;
      el.dataset.s = st;
      if (detail) $('small', el).textContent = detail;
    };
    let r;
    try {
      await freshRelay();
      r = await PS.nettest.run((k, st) => set(k, st));
    } catch (e) {
      $('#checkOut').innerHTML = `<div class="verdict bad"><b>The check couldn\u2019t run</b><p>${esc(e.message)}</p></div>`;
      return;
    }
    set('lobby', r.lobby ? 'ok' : 'bad', r.lobby ? 'Reachable, room codes work' : 'Unreachable, use direct invite codes');
    set('nat', r.nat === 'open' ? 'ok' : r.nat === 'strict' ? 'warn' : 'bad',
      r.nat === 'open' ? 'Open NAT' + (r.ipv6 ? ', IPv6 available' : '') : r.nat === 'strict' ? 'Strict (symmetric) NAT' : 'Blocked on this network');
    if (r.turn !== null) set('turn', r.turn ? 'ok' : 'bad', r.turn ? 'Relay is working' : 'Relay didn\u2019t answer');
    const v = PS.nettest.verdict(r);
    $('#checkOut').innerHTML = `<div class="verdict ${v.level}"><b>${esc(v.title)}</b>${v.tips.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
      ${r.publicIps.length ? `<p class="note" style="margin-top:12px">Your public address: ${r.publicIps.map(esc).join(', ')}</p>` : ''}`;
  }

  // ---------- direct invites (host) ----------
  document.addEventListener('click', (e) => { if (e.target.closest('[data-direct-invite]')) hostDirectInvite(); });
  const hasRelay = () => !!((P.turn && P.turn.url) || (P.relayWorker && P.relayWorker.url));
  async function hostDirectInvite() {
    if (S.role !== 'host' || !S.net || !S.net.directInvite) { toast('Start hosting first'); return; }
    await freshRelay();
    openModal(`<h2>Direct invite</h2><p class="note">No lobby server: you and your friend swap codes containing your connection details, then connect straight to each other. One invite per friend.</p>
      <p class="dstatus" id="dStatus">Making your invite…</p>`);
    let inv;
    try { inv = await S.net.directInvite(); }
    catch (e) { $('#dStatus').textContent = 'Couldn\u2019t make an invite: ' + e.message; $('#dStatus').className = 'dstatus bad'; return; }
    const link = `${location.origin}${location.pathname}?direct=${inv.code}`;
    $('#modalBody').innerHTML = `<h2>Direct invite</h2><p class="note">No lobby server: you and your friend swap codes containing your connection details, then connect straight to each other. One invite per friend.</p>
      <div class="step"><span class="n">1</span><div><b>Send this invite to your friend</b>
        <textarea class="codebox" readonly>${esc(link)}</textarea>
        <div class="row2 tight"><button class="ghost" id="dShare">Share</button><button class="ghost" id="dCopy">Copy</button></div></div></div>
      <div class="step"><span class="n">2</span><div><b>Paste the reply code they send back</b>
        <textarea class="codebox" id="dReply" placeholder="PHO1…" spellcheck="false" autocapitalize="off"></textarea>
        <button class="big primary tight" id="dConnect"><b>Connect</b></button></div></div>
      ${inv.sharedRelay ? '<p class="note">Your relay is included, so this friend can connect even from a strict network.</p>' : ''}
      <p class="dstatus" id="dStatus"></p>
      <button class="link" id="dAnother" hidden>Invite another friend</button>`;
    $('#dShare').onclick = async () => {
      try { if (navigator.share) await navigator.share({ title: 'PhoStation direct invite', text: 'Open this to join my PS1 game:', url: link }); else copyText(link, 'Invite'); } catch (e) {}
    };
    $('#dCopy').onclick = () => copyText(link, 'Invite');
    const status = (t, cls) => { $('#dStatus').textContent = t; $('#dStatus').className = 'dstatus ' + (cls || ''); };
    $('#dConnect').onclick = async () => {
      const text = $('#dReply').value;
      if (!PS.direct.findCode(text)) { status('Paste the whole reply code (it starts with PHO1).', 'bad'); return; }
      $('#dConnect').disabled = true;
      status('Connecting directly…');
      try { await inv.accept(text); }
      catch (e) { status(e.message, 'bad'); $('#dConnect').disabled = false; return; }
      const watch = () => {
        const st = inv.pc.connectionState;
        if (st === 'connected') { status('Connected! They\u2019re in the room.', 'ok'); $('#dAnother').hidden = false; }
        else if (st === 'failed') status('Couldn\u2019t connect directly. Both networks may have strict NAT. Run the connection check on both phones, or add a TURN relay in Settings.', 'bad');
      };
      inv.pc.addEventListener('connectionstatechange', watch);
      watch();
    };
    $('#dAnother').onclick = hostDirectInvite;
  }

  // ---------- direct invites (guest) ----------
  $('#directJoinBtn').onclick = () => guestDirectStart('');
  function guestDirectStart(prefill) {
    openModal(`<h2>Join with a direct invite</h2><p class="note">Paste the invite your friend sent. You\u2019ll get a reply code to send back, then you connect straight to each other.</p>
      <textarea class="codebox" id="gInvite" placeholder="Invite link or code" spellcheck="false" autocapitalize="off">${esc(prefill)}</textarea>
      <div class="seg" id="gWant"><button data-want="player" class="on">Play</button><button data-want="spectator">Watch</button></div>
      <button class="big primary" id="gMake"><b>Make my reply code</b></button>
      <p class="dstatus" id="gStatus"></p>`);
    let want = 'player';
    $$('#gWant button').forEach((b) => (b.onclick = () => { want = b.dataset.want; $$('#gWant button').forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#gMake').onclick = async () => {
      const code = PS.direct.findCode($('#gInvite').value);
      if (!code) { $('#gStatus').textContent = 'Paste the whole invite (it contains PHO1).'; $('#gStatus').className = 'dstatus bad'; return; }
      $('#gStatus').textContent = 'Making your reply code…';
      $('#gStatus').className = 'dstatus';
      S.role = 'guest';
      S.code = 'DIRECT';
      PS.clientIdFor('direct');
      S.want = want;
      enterPlay();
      $('#roomChip').textContent = 'Direct';
      setWaiting('Making your reply code…');
      if (PS.ice.relayServers(false).length) await freshRelay();
      S.net = PS.net.joinDirect(code, myName(), want, directHandlers);
    };
  }
  const directHandlers = {};
  function showReply(code) {
    openModal(`<h2>Send this reply to the host</h2><p class="note">They paste it into their invite screen. Keep this screen open until you\u2019re connected.</p>
      <textarea class="codebox" readonly>${esc(code)}</textarea>
      <div class="row2 tight"><button class="ghost" id="rShare">Share</button><button class="ghost" id="rCopy">Copy</button></div>
      <p class="dstatus" id="rStatus">Waiting for the host to connect…</p>`);
    $('#rShare').onclick = async () => { try { if (navigator.share) await navigator.share({ text: code }); else copyText(code, 'Reply'); } catch (e) {} };
    $('#rCopy').onclick = () => copyText(code, 'Reply');
  }
  const directParam = new URLSearchParams(location.search).get('direct');
  (async () => {
    const q = new URLSearchParams(location.search);
    // A friend's room invite can carry their relay logins for this session.
    if (q.get('r')) { try { PS.ice.useShared(await PS.direct.unpackRelay(q.get('r'))); } catch (e) {} }
    // Setup link printed by relay/setup-coturn.sh: saves your own TURN server.
    if (q.get('turn')) {
      try {
        const t = JSON.parse(atob(q.get('turn').replace(/-/g, '+').replace(/_/g, '/')));
        if (t.url) { P.turn = { url: t.url, user: t.user || '', pass: t.pass || '' }; P.relayMode = 'own'; toast('Your relay server is saved', 4000); }
      } catch (e) { toast('That relay setup link is damaged'); }
      history.replaceState(null, '', location.pathname);
    }
  })();

  // ---------- join ----------
  $('#codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $$('#wantSeg button').forEach((b) => (b.onclick = () => {
    S.want = b.dataset.want;
    $$('#wantSeg button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
  }));
  $('#joinBtn').onclick = async () => {
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code.length !== 5) { toast('Room codes have 5 characters'); return; }
    S.role = 'guest';
    S.code = code;
    PS.clientIdFor(code); // same id every time this device joins this room
    P.lastRoom = { code, want: S.want, at: Date.now() };
    enterPlay();
    setWaiting('Connecting…');
    await freshRelay();
    S.net = PS.net.join(code, myName(), S.want, guestHandlers);
  };
  const guestHandlers = {
    status(msg) { if (msg) setWaiting(msg); else setWaiting(S.gotStream ? null : 'Waiting for the host to start the game…'); },
    welcome() { },
    roster: onRoster,
    stream(s) {
      const v = $('#remote');
      v.srcObject = s;
      v.muted = true;
      v.play().catch(() => {});
      S.gotStream = true;
      setWaiting(null);
      $('#tapSound').hidden = false;
      applyView();
    },
    lost() { setWaiting('Connection lost. Reconnecting, your port is held…'); },
    note(msg) { toast(msg, 3500); },
    stats({ rtt, fps, tier, path }) {
      const parts = [];
      if (rtt != null) parts.push(`${rtt} ms`);
      if (fps != null) parts.push(`${fps} fps`);
      if (tier) parts.push(tier);
      if (path) parts.push(path);
      setStat(parts.join('  '), rtt);
    },
    ended(msg) {
      $('#endedMsg').textContent = msg;
      $('#ended').hidden = false;
    },
  };
  Object.assign(directHandlers, guestHandlers, {
    reply: showReply,
    status(msg) {
      guestHandlers.status(msg);
      const el = $('#rStatus');
      if (el && msg) el.textContent = msg;
    },
    welcome() { closeModal(); toast('Connected directly'); },
  });
  if (directParam) { show('join'); guestDirectStart(directParam); }
  $('#endedBtn').onclick = () => (location.href = location.pathname);

  // ---------- sound unlock ----------
  function unlockSound() {
    const v = $('#remote');
    if (S.gotStream) { v.muted = false; v.play().catch(() => {}); }
    S.net && S.net.unlockAudio && S.net.unlockAudio();
    $('#tapSound').hidden = true;
  }
  PS.needsTap = () => { if (S.role === 'guest') $('#tapSound').hidden = false; };
  $('#tapSound').onclick = unlockSound;
  $('#play').addEventListener('pointerdown', () => { if (!$('#tapSound').hidden) unlockSound(); }, true);

  // ---------- play ----------
  function enterPlay() {
    show('play');
    document.body.classList.toggle('is-host', S.role === 'host');
    document.body.classList.toggle('is-guest', S.role === 'guest');
    $('#roomChip').textContent = S.code;
    renderPad();
    requestWakeLock();
  }
  $('#roomChip').onclick = share;

  function setStat(text, rtt) {
    const c = $('#statChip');
    c.textContent = text;
    c.dataset.q = rtt == null ? '' : rtt < 80 ? 'good' : rtt < 160 ? 'ok' : 'bad';
  }

  function onRoster(msg) {
    S.roster = msg.roster;
    S.view = msg.view;
    S.lockViews = msg.lockViews;
    S.hostState = msg;
    const me = S.role === 'host' ? msg.roster.find((m) => m.isHost) : msg.roster.find((m) => m.clientId === PS.clientId);
    if (me) {
      const old = S.myPort;
      S.myPort = me.port;
      S.myRole = me.role;
      if (S.role === 'host' && me.port != null && old !== me.port) PS.emu.setInput(me.port, PS.controls.state());
    }
    if (S.lockViews) S.localFull = false;
    if (S.role === 'guest') $('#pausedBanner').hidden = !msg.paused;
    $('#micBtn').classList.toggle('on', !!(S.net && S.net.voiceOn));
    applyView();
    const key = JSON.stringify([msg.roster.map((m) => [m.clientId, m.name, m.port, m.voice, m.connected]), msg.view, msg.lockViews, msg.locked, msg.maxPorts, msg.quality, msg.running]);
    if (key !== S.rosterKey) { S.rosterKey = key; if (sheetOpen()) renderSheet(); }
    else if (sheetOpen()) refreshPlayers();
  }

  function applyView() {
    const inner = S.role === 'host' ? $('#game') : $('#remote');
    const full = S.ejsUi || S.myPort == null || S.localFull;
    PS.view.apply($('#screen'), $('#frame'), inner, full ? PS.view.FULL : PS.view.rect(S.view, S.myPort), P.fit === 'stretch');
  }
  new ResizeObserver(() => applyView()).observe($('#screen'));

  // ---------- controls ----------
  PS.controls.init($('#pad'), {
    onChange(st) {
      if (S.role === 'host') { if (S.myPort != null) PS.emu.setInput(S.myPort, st); }
      else if (S.net) S.net.sendInput(st);
    },
    onAction: handleAction,
    keyboard: () => S.role === 'guest',
    gamepad: () => S.role === 'guest',
  });

  async function renderPad() {
    const play = $('#play');
    const scr = $('#screen');
    if (S.skinId === 'default' || S.skinId === 'sticks') {
      play.classList.remove('delta');
      scr.removeAttribute('style');
      $('#skinBg').innerHTML = '';
      PS.controls.renderDefault(S.skinId === 'sticks', { ff: S.role === 'host' });
    } else {
      const skin = await PS.delta.load(S.skinId).catch(() => null);
      if (!skin) { S.skinId = P.skin = 'default'; return renderPad(); }
      play.classList.add('delta');
      const r = PS.controls.renderDelta(skin, $('#skinBg'));
      Object.assign(scr.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    }
    applyView();
  }
  let rT = null;
  addEventListener('resize', () => {
    clearTimeout(rT);
    rT = setTimeout(() => { if (document.body.dataset.view === 'play' && $('#play').classList.contains('delta')) renderPad(); }, 120);
  });

  async function handleAction(a, down) {
    if (a === 'menu') return openSheet();
    if (S.role !== 'host' || !S.running) return;
    if (a === 'ff' && down !== undefined) { S.ff = PS.emu.setFastForward(down); return; } // hold to fast forward
    try {
      if (a === 'qs') { await PS.emu.saveState(0); toast('Quick save done'); }
      if (a === 'ql') toast((await PS.emu.loadState(0)) ? 'Quick save loaded' : 'No quick save yet');
      if (a === 'ff') { S.ff = PS.emu.toggleFastForward(); toast(S.ff ? 'Fast forward on' : 'Fast forward off'); }
    } catch (e) { toast(e.message); }
  }

  // ---------- voice ----------
  $('#micBtn').onclick = toggleVoice;
  async function toggleVoice() {
    if (!S.net) return;
    try {
      if (S.net.voiceOn) { S.net.voiceStop(); toast('Voice chat off'); }
      else { await S.net.voiceStart(); toast('Voice chat on'); }
    } catch (e) {
      toast('Microphone access was blocked. Allow it in the browser settings to talk.', 4500);
    }
    $('#micBtn').classList.toggle('on', S.net.voiceOn);
    if (sheetOpen()) renderSheet();
  }

  // ---------- wake lock ----------
  let wake = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); } } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.body.dataset.view === 'play') requestWakeLock();
  });

  // ---------- sheet ----------
  const sheetOpen = () => !$('#sheetWrap').hidden;
  // Solo games pause while the menu is open.
  function openSheet() {
    if (S.role === 'host' && S.running && !PS.emu.paused && !guestsConnected()) { S.autoPaused = true; setPause(true); }
    renderSheet();
    $('#sheetWrap').hidden = false;
  }
  function closeSheet() {
    $('#sheetWrap').hidden = true;
    if (S.autoPaused) { S.autoPaused = false; setPause(false); }
  }
  $('#menuBtn').onclick = openSheet;

  function portsStrip() {
    const max = S.hostState ? S.hostState.maxPorts : 2;
    let html = '<div class="ports">';
    for (let p = 0; p < 4; p++) {
      const m = S.roster.find((x) => x.port === p);
      const off = p >= max;
      html += `<div class="port p${p + 1} ${m ? 'taken' : ''} ${off ? 'off' : ''} ${m && !m.connected ? 'away' : ''}">
        <span class="num">${p + 1}</span><span class="who">${off ? 'Multitap' : m ? esc(m.name) : 'Open'}</span></div>`;
    }
    return html + '</div>';
  }

  function playerRows() {
    const host = S.role === 'host';
    const max = S.hostState ? S.hostState.maxPorts : 2;
    return S.roster.map((m) => {
      const me = host ? m.isHost : m.clientId === PS.clientId;
      let ctl = `<span class="tag">${m.port != null ? 'P' + (m.port + 1) : 'Watching'}</span>`;
      if (host) {
        const opts = [...Array(max).keys()].map((p) => `<option value="${p}" ${m.port === p ? 'selected' : ''}>P${p + 1}</option>`).join('')
          + `<option value="spec" ${m.port == null ? 'selected' : ''}>Watch</option>`;
        ctl = `<select data-do="port" data-cid="${esc(m.clientId)}" aria-label="Port for ${esc(m.name)}">${opts}</select>`
          + (m.isHost ? '' : `<button class="mini danger" data-do="kick" data-cid="${esc(m.clientId)}">Remove</button>`);
      }
      return `<div class="prow ${m.connected ? '' : 'away'}" data-row="${esc(m.clientId)}">
        <span class="dot ${m.voice ? 'talk' : ''}" title="${m.voice ? 'Voice on' : ''}"></span>
        <span class="pname">${esc(m.name)}${me ? ' <i>(you)</i>' : ''}<small>${esc(statusOf(m))}</small></span>${ctl}</div>`;
    }).join('');
  }
  function statusOf(m) {
    if (!m.connected) return 'reconnecting';
    if (m.isHost) return 'host';
    const bits = [];
    if (m.rtt != null) bits.push(`${m.rtt} ms`);
    if (m.tier) bits.push(m.tier);
    if (m.path) bits.push(m.path);
    else if (m.direct) bits.push('direct link');
    return bits.join(', ');
  }
  // Only touch the status text so open dropdowns aren't rebuilt under the user's finger.
  function refreshPlayers() {
    for (const m of S.roster) {
      const row = document.querySelector(`[data-row="${CSS.escape(m.clientId)}"] small`);
      if (row) row.textContent = statusOf(m);
    }
  }

  async function skinsHtml() {
    const list = await PS.delta.list();
    const row = (id, name, del) => `<label class="skinrow"><input type="radio" name="skin" value="${esc(id)}" ${S.skinId === id ? 'checked' : ''} data-do="skin"><span>${esc(name)}</span>${del ? `<button class="mini" data-do="delskin" data-id="${esc(id)}">Delete</button>` : ''}</label>`;
    return row('default', 'Classic pad', false) + row('sticks', 'Classic pad with analog sticks', false)
      + list.map((s) => row(s.id, s.name, true)).join('')
      + `<button class="ghost wide" data-do="importskin">Import a Delta skin</button>
         <label class="toggle"><input type="checkbox" data-do="haptics" ${P.haptics ? 'checked' : ''}><span><b>Haptics</b><small>Tick on each press (Android, iPhone with iOS 18+)</small></span></label>`;
  }

  async function renderSheet() {
    const host = S.role === 'host';
    const st = S.hostState || {};
    const views = [['full', 'Whole screen'], ['h2', 'Top / bottom'], ['v2', 'Left / right'], ['q4', 'Quarters']];
    const keep = { name: $('#cheatName') && $('#cheatName').value, code: $('#cheatCode') && $('#cheatCode').value };
    let html = '';
    if (host && S.running) {
      const p = PS.emu.paused && !S.autoPaused;
      html += `<div class="row2 top"><button class="ghost ${p ? 'on' : ''}" data-do="pause">${p ? 'Resume game' : 'Pause for everyone'}</button>
        <button class="ghost" data-do="shot">Screenshot</button></div>`;
    } else if (!host) html += `<button class="ghost wide top" data-do="shot">Screenshot</button>`;
    html += `<h3>Players</h3>${portsStrip()}<div id="sheetPlayers">${playerRows()}</div>`;
    if (host) html += `<div class="row2 tight"><button class="ghost" data-direct-invite>Direct invite</button><button class="ghost" data-check>Check connection</button></div>`;

    html += `<h3>Voice</h3><button class="ghost wide ${S.net && S.net.voiceOn ? 'on' : ''}" data-do="voice">${S.net && S.net.voiceOn ? 'Turn voice chat off' : 'Turn voice chat on'}</button>`;

    if (host) {
      html += `<h3>Split screen</h3><p class="note">Pick how the game divides its screen. Each player then sees only their own part.</p>
        <div class="seg four">${views.map(([v, l]) => `<button data-do="view" data-v="${v}" class="${st.view === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <label class="toggle"><input type="checkbox" data-do="lockviews" ${st.lockViews ? 'checked' : ''}><span><b>No screen watching</b><small>Players can\u2019t switch to the whole screen</small></span></label>`;
      html += `<h3>Room</h3>
        <label class="toggle"><input type="checkbox" data-do="multitap" ${st.maxPorts === 4 ? 'checked' : ''}><span><b>Multitap, 4 ports</b><small>Restarts the game to apply</small></span></label>
        <label class="toggle"><input type="checkbox" data-do="lock" ${st.locked ? 'checked' : ''}><span><b>Lock room</b><small>No new people can join. Dropped players can still return.</small></span></label>
        <label class="field inline"><span>Stream quality</span><select data-do="quality">
          <option value="auto" ${st.quality === 'auto' ? 'selected' : ''}>Automatic</option>
          ${PS.net.TIERS.map((t) => `<option value="${t.id}" ${st.quality === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
        </select></label>
        <button class="ghost wide" data-do="share">Share invite</button>`;
      if (S.running) {
        html += `<h3>Save states</h3><div class="slots">`;
        for (const i of ['auto', 1, 2, 3]) {
          const info = await PS.emu.stateInfo(i).catch(() => null);
          const label = i === 'auto' ? 'Autosave' : `Slot ${i}`;
          html += `<div class="slot"><span class="thumb" ${info && info.thumb ? `style="background-image:url(${info.thumb})"` : ''}></span>
            <span>${label}<small>${info ? ago(info.at) : 'Empty'}</small></span>
            ${i === 'auto' ? '' : `<button class="mini" data-do="save" data-slot="${i}">Save</button>`}
            <button class="mini" data-do="load" data-slot="${i}" ${info ? '' : 'disabled'}>Load</button></div>`;
        }
        html += `</div><h3>Speed</h3>
          <div class="seg quad">${['quality', 'balanced', 'fast', 'turbo'].map((v) => `<button data-do="perf" data-v="${v}" class="${S.perf === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
          <p class="note">${PERF_NOTES[S.perf]}</p>
          ${PS.emu.canUncap() ? `<label class="toggle"><input type="checkbox" data-do="uncap" ${S.uncapped ? 'checked' : ''}><span><b>Ignore the 30 fps screen limit</b><small>Use when Low Power Mode is on. Turns itself on when needed.</small></span></label>` : ''}`;
        html += `<h3>Game</h3><div class="row2">
          <button class="ghost" data-do="ff">${S.ff ? 'Stop fast forward' : 'Fast forward'}</button>
          <button class="ghost" data-do="restart">Restart</button></div>
          <button class="ghost wide" data-do="swap">Change game</button>
          <button class="ghost wide" data-do="ejs">${S.ejsUi ? 'Hide emulator menu' : 'Show emulator menu'}</button>`;
        html += cheatsHtml();
      }
    } else if (!st.lockViews && S.myPort != null && st.view !== 'full') {
      html += `<h3>View</h3><label class="toggle"><input type="checkbox" data-do="localfull" ${S.localFull ? 'checked' : ''}><span><b>Show the whole screen</b><small>The host allows it in this room</small></span></label>`;
    }

    html += displayHtml();
    html += `<h3>Controller</h3>${await skinsHtml()}${padLookHtml()}`;
    html += `<button class="big danger" data-do="leave"><b>${host ? 'End session' : 'Leave room'}</b></button>`;
    $('#sheetBody').innerHTML = html;
    if (keep.name && $('#cheatName')) $('#cheatName').value = keep.name;
    if (keep.code && $('#cheatCode')) $('#cheatCode').value = keep.code;
  }

  function displayHtml() {
    const f = P.filter || 'sharp', fit = P.fit || '43';
    const opt = (k, v, l, cur) => `<button data-do="${k}" data-v="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`;
    return `<h3>Display</h3>
      <div class="seg quad">${opt('filter', 'sharp', 'Sharp', f)}${opt('filter', 'smooth', 'Smooth', f)}${opt('filter', 'scan', 'Scanlines', f)}${opt('filter', 'crt', 'CRT', f)}</div>
      <div class="seg">${opt('fit', '43', 'Original 4:3', fit)}${opt('fit', 'stretch', 'Fill screen', fit)}</div>`;
  }

  const TURBO = [['Cross', 0], ['Circle', 8], ['Square', 1], ['Triangle', 9], ['L1', 10], ['R1', 11], ['L2', 12], ['R2', 13]];
  function padLookHtml() {
    const t = P.turbo || 0;
    return `<h3>Turbo buttons</h3><p class="note">Held turbo buttons press themselves about 15 times a second.</p>
      <div class="chips">${TURBO.map(([l, b]) => `<button data-do="turbo" data-b="${b}" class="chip-t ${t & (1 << b) ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label class="range"><span>Controller size</span><input type="range" min="0.75" max="1.3" step="0.05" value="${P.padSize || 1}" data-do="padsize"></label>
      <label class="range"><span>Controller opacity</span><input type="range" min="0.25" max="1" step="0.05" value="${P.padAlpha == null ? 1 : P.padAlpha}" data-do="padalpha"></label>`;
  }

  function cheatsHtml() {
    if (!PS.emu.cheatsSupported()) return '';
    const rows = (S.cheats || []).map((c, i) => `<div class="cheat"><label class="toggle"><input type="checkbox" data-do="cheat" data-i="${i}" ${c.on ? 'checked' : ''}>
      <span><b>${esc(c.name)}</b><small>${esc(c.code.split(/\n|\+/)[0])}${c.code.split(/\n|\+/).length > 1 ? ' …' : ''}</small></span></label>
      <button class="mini" data-do="delcheat" data-i="${i}" aria-label="Delete cheat">×</button></div>`).join('');
    return `<h3>Cheats</h3><p class="note">GameShark codes, one per line, like 80012345 0063. Saved for this game.</p>${rows}
      <label class="field"><span>Name</span><input id="cheatName" placeholder="Infinite health" autocomplete="off"></label>
      <label class="field"><span>Code</span><textarea id="cheatCode" rows="3" placeholder="80012345 0063" autocapitalize="characters" spellcheck="false"></textarea></label>
      <button class="ghost wide" data-do="addcheat">Add cheat</button>`;
  }
  function saveCheats() {
    PS.emu.applyCheats(S.cheats);
    if (S.gameId) PS.library.update(S.gameId, { cheats: S.cheats }).catch(() => {});
  }

  async function onSheetAction(e) {
    const t = e.target.closest('[data-do]');
    if (!t) return;
    const d = t.dataset.do;
    if (e.type === 'click' && (t.tagName === 'SELECT' || (t.tagName === 'INPUT'))) return; // handled on change
    if (e.type === 'change' && t.tagName === 'BUTTON') return;
    const net = S.net;
    try {
      switch (d) {
        case 'close': closeSheet(); break;
        case 'voice': await toggleVoice(); break;
        case 'share': share(); break;
        case 'port': net.setPort(t.dataset.cid, t.value === 'spec' ? null : +t.value); break;
        case 'kick': if (confirm('Remove this player from the room?')) net.kick(t.dataset.cid); break;
        case 'view': net.setView(t.dataset.v); break;
        case 'lockviews': net.setLockViews(t.checked); break;
        case 'lock': net.setLocked(t.checked); break;
        case 'quality': net.setQuality(t.value); toast(`Stream quality: ${t.selectedOptions[0].textContent}`); break;
        case 'multitap':
          net.setMaxPorts(t.checked ? 4 : 2);
          if (S.running) { PS.emu.setMultitap(t.checked); toast(t.checked ? 'Multitap on, game restarted' : 'Multitap off, game restarted'); }
          break;
        case 'save': await PS.emu.saveState(+t.dataset.slot); toast(`Saved to slot ${t.dataset.slot}`); renderSheet(); break;
        case 'load': toast((await PS.emu.loadState(+t.dataset.slot)) ? `Loaded slot ${t.dataset.slot}` : 'That slot is empty'); closeSheet(); break;
        case 'ff': S.ff = PS.emu.toggleFastForward(); renderSheet(); break;
        case 'restart': if (confirm('Restart the game for everyone?')) { PS.emu.restart(); closeSheet(); } break;
        case 'ejs':
          S.ejsUi = !S.ejsUi;
          document.body.classList.toggle('ejs-ui', S.ejsUi);
          PS.emu.setEjsUi(S.ejsUi);
          applyView(); closeSheet();
          if (S.ejsUi) toast('Emulator menu shown. Open PhoStation\u2019s menu (top right) to hide it.');
          break;
        case 'perf':
          S.perf = P.perf = t.dataset.v;
          PS.emu.setPerf(S.perf);
          if (S.gameId) PS.library.update(S.gameId, { perf: S.perf }).catch(() => {});
          renderSheet();
          break;
        case 'uncap': S.uncapped = PS.emu.setUncapped(t.checked) && t.checked; break;
        case 'swap': swapGameMenu(); break;
        case 'pause': S.autoPaused = false; setPause(!PS.emu.paused); renderSheet(); break;
        case 'shot': await takeScreenshot(); break;
        case 'filter': P.filter = t.dataset.v; applyLook(); renderSheet(); break;
        case 'fit': P.fit = t.dataset.v; applyView(); renderSheet(); break;
        case 'turbo': P.turbo = (P.turbo || 0) ^ (1 << +t.dataset.b); applyLook(); t.classList.toggle('on'); break;
        case 'padsize': P.padSize = +t.value; applyLook(); break;
        case 'padalpha': P.padAlpha = +t.value; applyLook(); break;
        case 'cheat': S.cheats[+t.dataset.i].on = t.checked; saveCheats(); break;
        case 'delcheat': S.cheats.splice(+t.dataset.i, 1); saveCheats(); renderSheet(); break;
        case 'addcheat': {
          const code = $('#cheatCode').value;
          if (!PS.emu.normalizeCheat(code)) { toast('That code doesn\u2019t look right. Each line needs 8 + 4 hex digits.', 4500); break; }
          S.cheats.push({ name: $('#cheatName').value.trim() || `Cheat ${S.cheats.length + 1}`, code: code.trim(), on: true });
          $('#cheatName').value = ''; $('#cheatCode').value = '';
          saveCheats();
          toast('Cheat added and switched on');
          renderSheet();
          break;
        }
        case 'localfull': S.localFull = t.checked; applyView(); break;
        case 'skin': S.skinId = P.skin = t.value; renderPad(); break;
        case 'delskin':
          e.preventDefault();
          if (confirm('Delete this skin?')) {
            await PS.delta.remove(t.dataset.id);
            if (S.skinId === t.dataset.id) { S.skinId = P.skin = 'default'; renderPad(); }
            rerenderSkinsSomewhere();
          }
          break;
        case 'importskin': $('#skinFile').click(); break;
        case 'haptics': P.haptics = t.checked; break;
        case 'leave':
          if (!confirm(S.role === 'host' ? 'End the session for everyone?' : 'Leave this room?')) break;
          if (S.role === 'host') net.destroy(); else net.leave();
          setTimeout(() => (location.href = location.pathname), 350);
          break;
        case 'relaymode': P.relayMode = t.dataset.v; renderSettings(); break;
        case 'sharerelay': P.shareRelay = t.checked; break;
        case 'relayguide': relayGuide(); break;
        case 'relaysave': await saveRelay(); break;
      }
    } catch (err) { toast(err.message || String(err)); }
  }
  ['click', 'change'].forEach((ev) => {
    $('#sheetWrap').addEventListener(ev, onSheetAction);
    $('#settingsBody').addEventListener(ev, onSheetAction);
  });

  function rerenderSkinsSomewhere() {
    if (sheetOpen()) renderSheet();
    if (document.body.dataset.view === 'settings') renderSettings();
  }

  $('#skinFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    toast('Importing skin…', 8000);
    try {
      const skin = await PS.delta.importSkin(f);
      await PS.delta.save(skin);
      S.skinId = P.skin = skin.id;
      toast(`Imported \u201c${skin.name}\u201d`);
      if (document.body.dataset.view === 'play') renderPad();
      rerenderSkinsSomewhere();
    } catch (err) {
      toast(err.message || 'That skin could not be imported.', 4500);
    }
  };

  // ---------- settings ----------
  async function renderSettings() {
    const t = P.turn || {};
    $('#settingsBody').innerHTML = `
      <h3>Controller</h3>${await skinsHtml()}
      <h3>Connection</h3>
      <p class="note">See whether this network allows peer-to-peer, what kind of NAT you\u2019re behind, and whether your relay works.</p>
      <button class="ghost wide" data-check>Check my connection</button>
      <h3>Your relay (TURN)</h3>
      <p class="note">A relay carries the game when two networks can\u2019t connect directly (the check says Strict or Blocked). Set one up once and it\u2019s yours. Only needed by the host; friends you invite can borrow it.</p>
      <div class="seg" id="relayMode">
        <button data-do="relaymode" data-v="cf" class="${(P.relayMode || 'cf') === 'cf' ? 'on' : ''}">Cloudflare (free)</button>
        <button data-do="relaymode" data-v="own" class="${P.relayMode === 'own' ? 'on' : ''}">Own server</button>
      </div>
      ${(P.relayMode || 'cf') === 'cf' ? `
      <label class="field"><span>Your Worker address</span><input id="cfUrl" value="${esc((P.relayWorker && P.relayWorker.url) || '')}" placeholder="https://phostation-relay.you.workers.dev" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Access code</span><input id="cfCode" type="password" value="${esc((P.relayWorker && P.relayWorker.code) || '')}" autocomplete="off"></label>` : `
      <label class="field"><span>TURN URL</span><input id="turnUrl" value="${esc(t.url || '')}" placeholder="turn:203.0.113.5:3478" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Username</span><input id="turnUser" value="${esc(t.user || '')}" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Password</span><input id="turnPass" type="password" value="${esc(t.pass || '')}" autocomplete="off"></label>`}
      <div class="row2"><button class="ghost" data-do="relaysave">Save and test</button><button class="ghost" data-do="relayguide">Setup guide</button></div>
      <p class="dstatus" id="relayStatus"></p>
      <label class="toggle"><input type="checkbox" data-do="sharerelay" ${P.shareRelay ? 'checked' : ''}><span><b>Share my relay with friends I invite</b><small>Invites carry short-lived relay logins (valid up to a day), so friends on strict networks can still connect.</small></span></label>
      <h3>About</h3>
      <p class="note">PhoStation runs EmulatorJS with the PCSX-ReARMed core. Bring your own game discs and BIOS.</p>`;
  }

  // ---------- your relay ----------
  async function saveRelay() {
    const st = $('#relayStatus');
    const say = (msg, cls) => { st.textContent = msg; st.className = 'dstatus ' + (cls || ''); };
    if ((P.relayMode || 'cf') === 'cf') {
      const url = $('#cfUrl').value.trim(), code = $('#cfCode').value;
      P.relayWorker = url ? { url, code } : null;
      P.turn = null;
      PS.ice.clearCache();
      if (!url) { say('Relay turned off.'); return; }
      say('Asking your Worker for relay logins…');
      try { await PS.ice.refresh(true); } catch (e) { say(e.message, 'bad'); return; }
    } else {
      const url = $('#turnUrl').value.trim();
      P.turn = url ? { url, user: $('#turnUser').value.trim(), pass: $('#turnPass').value } : null;
      P.relayWorker = null;
      PS.ice.clearCache();
      if (!url) { say('Relay turned off.'); return; }
    }
    say('Testing the relay…');
    const list = PS.ice.relayServers(false);
    try {
      const pc = new RTCPeerConnection({ iceServers: list, iceTransportPolicy: 'relay' });
      let ok = false;
      pc.onicecandidate = (e) => { if (e.candidate && / typ relay /.test(e.candidate.candidate)) ok = true; };
      pc.createDataChannel('t');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => { const tm = setTimeout(r, 8000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(tm); r(); } }; });
      pc.close();
      say(ok ? 'Relay works. It\u2019s used automatically when a direct connection fails.' : 'Saved, but the relay didn\u2019t answer. Check the details and the server\u2019s firewall.', ok ? 'ok' : 'bad');
    } catch (e) { say('Saved, but the test couldn\u2019t run: ' + e.message, 'bad'); }
  }

  function relayGuide() {
    openModal(`<h2>Set up your free relay</h2>
      <p class="note">Pick one. Cloudflare is easiest and can be done from your phone in about 10 minutes.</p>
      <h3>Cloudflare (free, recommended)</h3>
      <p class="note">Cloudflare\u2019s relay is free for the first 1,000 GB each month, far more than gaming uses. A tiny Worker (also free) keeps your Cloudflare key secret and hands PhoStation short-lived logins.</p>
      <div class="step"><span class="n">1</span><div><b>Make a free Cloudflare account</b>Sign up at dash.cloudflare.com.</div></div>
      <div class="step"><span class="n">2</span><div><b>Create a TURN key</b>In the dashboard, find Realtime, then TURN Server, and create one. Copy the <i>Turn Token ID</i> and <i>API Token</i> (the token is only shown once).</div></div>
      <div class="step"><span class="n">3</span><div><b>Create a Worker</b>Workers &amp; Pages, Create, start from the Hello World template, name it e.g. phostation-relay, Deploy. Then Edit code, replace everything with <i>relay/cloudflare-worker.js</i> from this project, and Deploy.</div></div>
      <div class="step"><span class="n">4</span><div><b>Add three settings to the Worker</b>Settings, Variables and Secrets: <i>TURN_KEY_ID</i> (the Token ID), <i>TURN_KEY_API_TOKEN</i> (the API token, as a secret) and <i>ACCESS_CODE</i> (any password you make up, as a secret).</div></div>
      <div class="step"><span class="n">5</span><div><b>Connect PhoStation</b>Copy the Worker\u2019s address (ends in workers.dev), paste it and your access code here, and tap Save and test.</div></div>
      <h3>Your own server</h3>
      <p class="note">For a relay that\u2019s entirely yours, run <i>relay/setup-coturn.sh</i> on a free cloud server (for example Oracle Cloud\u2019s Always Free tier). It installs the coturn relay, opens the ports and prints a setup link; open that link on your phone and the relay is saved. Details are in <i>relay/README.md</i>.</p>
      <button class="big primary tight" data-close><b>Got it</b></button>`);
  }

  // ---------- service worker ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
