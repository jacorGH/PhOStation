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
    skinId: P.skin || 'default', ff: false, gotStream: false,
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
    const url = inviteUrl();
    try {
      if (navigator.share) await navigator.share({ title: 'PhoStation', text: `Join my PS1 room: ${S.code}`, url });
      else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    } catch (e) { /* share sheet dismissed */ }
  }

  // ---------- home ----------
  $('#nameInput').value = P.name || '';
  $('#nameInput').addEventListener('input', (e) => (P.name = e.target.value.trim()));
  $('#goHost').onclick = startHosting;
  $('#goJoin').onclick = () => { show('join'); setTimeout(() => $('#codeInput').focus(), 50); };
  $('#goSettings').onclick = () => { renderSettings(); show('settings'); };
  $$('[data-back]').forEach((b) => (b.onclick = () => {
    if (S.role === 'host' && S.net && !S.running) { S.net.destroy(); S.net = null; S.role = null; }
    show('home');
  }));
  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) { $('#codeInput').value = qRoom.toUpperCase().slice(0, 5); show('join'); }

  // ---------- host setup ----------
  function startHosting() {
    S.role = 'host';
    show('hostSetup');
    loadSavedBios();
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
        else setHostStatus('Lobby connection dropped. Reconnecting…');
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

  $('#gameFile').onchange = (e) => {
    const fs = [...e.target.files];
    if (!fs.length) return;
    S.files = fs;
    const cue = fs.find((f) => /\.cue$/i.test(f.name));
    $('#gameName').textContent = fs.length === 1 ? fs[0].name : `${fs.length} files${cue ? ', starting with ' + cue.name : ''}`;
    $('#gamePick').classList.add('set');
    const lonelyCue = fs.length === 1 && /\.cue$/i.test(fs[0].name);
    if (lonelyCue) toast('Select the .cue together with its .bin file(s)', 4000);
    $('#startBtn').disabled = lonelyCue;
  };

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

  $('#startBtn').onclick = async () => {
    S.multitap = $('#multitapChk').checked;
    if (!S.net) { S.net = soloNet(); S.myPort = 0; }
    S.net.setMaxPorts(S.multitap ? 4 : 2);
    enterPlay();
    setWaiting('Preparing the disc…');
    try {
      await PS.emu.load({
        files: S.files, bios: S.bios, multitap: S.multitap,
        handlers: { progress: setWaiting, started: onGameStarted },
      });
    } catch (err) {
      setWaiting(err.message || 'The game could not be loaded.');
    }
  };
  // Stand-in when PeerJS is unavailable: the game still runs locally on P1.
  function soloNet() {
    return {
      voiceOn: false, setMaxPorts() {}, setRunning() {}, destroy() {}, unlockAudio() {}, roster: () => [],
      voiceStart() { throw new Error('Voice needs the lobby connection.'); }, voiceStop() {},
    };
  }
  async function onGameStarted() {
    S.running = true;
    setWaiting(null);
    applyView();
    try { S.net.setRunning(await PS.emu.captureStream()); }
    catch (e) { toast('Streaming isn\u2019t supported in this browser, so friends won\u2019t see the game.', 5000); }
  }

  // ---------- join ----------
  $('#codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $$('#wantSeg button').forEach((b) => (b.onclick = () => {
    S.want = b.dataset.want;
    $$('#wantSeg button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
  }));
  $('#joinBtn').onclick = () => {
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code.length !== 5) { toast('Room codes have 5 characters'); return; }
    S.role = 'guest';
    S.code = code;
    enterPlay();
    setWaiting('Connecting…');
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
    stats({ rtt, fps, tier }) {
      const parts = [];
      if (rtt != null) parts.push(`${rtt} ms`);
      if (fps != null) parts.push(`${fps} fps`);
      if (tier) parts.push(tier);
      setStat(parts.join('  '), rtt);
    },
    ended(msg) {
      $('#endedMsg').textContent = msg;
      $('#ended').hidden = false;
    },
  };
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
    $('#micBtn').classList.toggle('on', !!(S.net && S.net.voiceOn));
    applyView();
    const key = JSON.stringify([msg.roster.map((m) => [m.clientId, m.name, m.port, m.voice, m.connected]), msg.view, msg.lockViews, msg.locked, msg.maxPorts, msg.quality, msg.running]);
    if (key !== S.rosterKey) { S.rosterKey = key; if (sheetOpen()) renderSheet(); }
    else if (sheetOpen()) refreshPlayers();
  }

  function applyView() {
    const inner = S.role === 'host' ? $('#game') : $('#remote');
    const full = S.ejsUi || S.myPort == null || S.localFull;
    PS.view.apply($('#screen'), $('#frame'), inner, full ? PS.view.FULL : PS.view.rect(S.view, S.myPort));
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
      PS.controls.renderDefault(S.skinId === 'sticks');
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

  async function handleAction(a) {
    if (a === 'menu') return openSheet();
    if (S.role !== 'host' || !S.running) return;
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
  function openSheet() { renderSheet(); $('#sheetWrap').hidden = false; }
  function closeSheet() { $('#sheetWrap').hidden = true; }
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
    return !m.connected ? 'reconnecting' : m.isHost ? 'host' : m.rtt != null ? `${m.rtt} ms${m.tier ? ', ' + m.tier : ''}` : '';
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
    let html = `<h3>Players</h3>${portsStrip()}<div id="sheetPlayers">${playerRows()}</div>`;

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
        for (let i = 1; i <= 3; i++) {
          const at = await PS.emu.stateInfo(i).catch(() => null);
          html += `<div class="slot"><span>Slot ${i}<small>${at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Empty'}</small></span>
            <button class="mini" data-do="save" data-slot="${i}">Save</button><button class="mini" data-do="load" data-slot="${i}" ${at ? '' : 'disabled'}>Load</button></div>`;
        }
        html += `</div><h3>Game</h3><div class="row2">
          <button class="ghost" data-do="ff">${S.ff ? 'Stop fast forward' : 'Fast forward'}</button>
          <button class="ghost" data-do="restart">Restart</button></div>
          <button class="ghost wide" data-do="ejs">${S.ejsUi ? 'Hide emulator menu' : 'Show emulator menu'}</button>`;
      }
    } else if (!st.lockViews && S.myPort != null && st.view !== 'full') {
      html += `<h3>View</h3><label class="toggle"><input type="checkbox" data-do="localfull" ${S.localFull ? 'checked' : ''}><span><b>Show the whole screen</b><small>The host allows it in this room</small></span></label>`;
    }

    html += `<h3>Controller</h3>${await skinsHtml()}`;
    html += `<button class="big danger" data-do="leave"><b>${host ? 'End session' : 'Leave room'}</b></button>`;
    $('#sheetBody').innerHTML = html;
  }

  async function onSheetAction(e) {
    const t = e.target.closest('[data-do]');
    if (!t) return;
    const d = t.dataset.do;
    if (e.type === 'click' && (t.tagName === 'SELECT' || (t.tagName === 'INPUT'))) return; // handled on change
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
          applyView(); closeSheet();
          if (S.ejsUi) toast('Emulator menu shown. Open the menu again to hide it.');
          break;
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
        case 'turnsave':
          P.turn = { url: $('#turnUrl').value.trim(), user: $('#turnUser').value.trim(), pass: $('#turnPass').value };
          toast('Connection settings saved. They apply to the next room.');
          break;
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
      <h3>Relay server (TURN)</h3>
      <p class="note">Leave this empty unless friends get stuck on \u201cConnecting\u201d. Some mobile networks block direct connections, and a TURN relay fixes that. Free relays are available from services like Metered or Twilio.</p>
      <label class="field"><span>TURN URL</span><input id="turnUrl" value="${esc(t.url || '')}" placeholder="turn:relay.example.com:443?transport=tcp" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Username</span><input id="turnUser" value="${esc(t.user || '')}" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Password</span><input id="turnPass" type="password" value="${esc(t.pass || '')}" autocomplete="off"></label>
      <button class="ghost wide" data-do="turnsave">Save connection settings</button>
      <h3>About</h3>
      <p class="note">PhoStation runs EmulatorJS with the PCSX-ReARMed core. Bring your own game discs and BIOS.</p>`;
  }

  // ---------- service worker ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
