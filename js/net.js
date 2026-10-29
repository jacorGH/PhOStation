/* PhoStation netplay.
   Host runs the emulator and streams video+audio to every guest. Guests send controller state back.
   Voice is a small mesh between everyone who has the mic on. */
(function () {
  const PS = window.PS;
  const PREFIX = 'phostation-v1-';
  const TIERS = [
    { id: 'ultra', name: 'Ultra', br: 4000000, scale: 1, fps: 60 },
    { id: 'high', name: 'High', br: 2500000, scale: 1, fps: 60 },
    { id: 'medium', name: 'Medium', br: 1200000, scale: 1.25, fps: 60 },
    { id: 'low', name: 'Low', br: 600000, scale: 1.75, fps: 30 },
    { id: 'potato', name: 'Potato', br: 300000, scale: 2.5, fps: 30 },
  ];
  const SIGNAL_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed'];

  function peerOpts() {
    const ice = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    const t = PS.prefs.turn;
    if (t && t.url) ice.push({ urls: t.url.split(',').map((s) => s.trim()).filter(Boolean), username: t.user || '', credential: t.pass || '' });
    return { debug: 1, config: { iceServers: ice } };
  }
  const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';

  // ---------- Voice mesh ----------
  class Voice {
    constructor() { this.mic = null; this.on = false; this.calls = new Map(); this.audios = new Map(); this.peer = null; }
    async start() {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      this.on = true;
    }
    // The member with the larger peer id places the call, so each pair connects exactly once.
    sync(roster, selfId) {
      const live = new Set(roster.filter((m) => m.voice && m.connected && m.peerId).map((m) => m.peerId));
      for (const [id, c] of this.calls) if (!live.has(id)) c.close();
      if (!this.on || !this.peer || !this.peer.open) return;
      for (const id of live) {
        if (id === selfId || this.calls.has(id) || !(selfId > id)) continue;
        this.track(this.peer.call(id, this.mic, { metadata: { kind: 'voice' } }));
      }
    }
    incoming(call) {
      call.answer(this.on && this.mic ? this.mic : undefined);
      this.track(call);
    }
    track(call) {
      if (!call) return;
      const id = call.peer;
      const old = this.calls.get(id);
      if (old && old !== call) old.close();
      this.calls.set(id, call);
      call.on('stream', (s) => this.play(id, s));
      const drop = () => {
        if (this.calls.get(id) !== call) return;
        this.calls.delete(id);
        const a = this.audios.get(id);
        if (a) { a.srcObject = null; a.remove(); this.audios.delete(id); }
      };
      call.on('close', drop);
      call.on('error', drop);
    }
    play(id, s) {
      let a = this.audios.get(id);
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true; a.playsInline = true;
        document.body.appendChild(a);
        this.audios.set(id, a);
      }
      a.srcObject = s;
      a.play().catch(() => PS.needsTap && PS.needsTap());
    }
    unlock() { this.audios.forEach((a) => a.play().catch(() => {})); }
    stop() {
      this.on = false;
      [...this.calls.values()].forEach((c) => c.close());
      this.calls.clear();
      this.audios.forEach((a) => { a.srcObject = null; a.remove(); });
      this.audios.clear();
      if (this.mic) this.mic.getTracks().forEach((t) => t.stop());
      this.mic = null;
    }
  }

  // =====================================================================
  // HOST
  // =====================================================================
  function createHost(code, name, h) {
    const hostId = PREFIX + code;
    const members = new Map();
    const self = { clientId: 'host', name: cleanName(name), role: 'player', port: 0, peerId: hostId, voice: false, connected: true, isHost: true };
    members.set('host', self);
    const st = { view: 'full', lockViews: true, locked: false, maxPorts: 2, quality: 'auto', running: false, paused: false };
    let peer = null, streamFactory = null, streamP = null, canvasW = 640, destroyed = false;
    // The stream is only created once someone is watching, so solo play doesn't pay for video encoding.
    const getStream = () => streamP || (streamP = Promise.resolve().then(streamFactory));
    const voice = new Voice();

    function open() {
      peer = new Peer(hostId, peerOpts());
      voice.peer = peer;
      peer.on('open', () => h.status('ready'));
      peer.on('connection', onConn);
      peer.on('call', (call) => {
        if (call.metadata && call.metadata.kind === 'voice') voice.incoming(call);
        else call.close();
      });
      peer.on('disconnected', () => {
        if (destroyed) return;
        h.status('reconnecting');
        setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1200);
      });
      peer.on('error', (err) => {
        console.warn('[host]', err.type, err);
        if (err.type === 'unavailable-id') h.status('taken');
        else if (SIGNAL_ERRORS.includes(err.type)) h.status('reconnecting');
      });
    }

    const rosterData = () => [...members.values()].map((m) => ({
      clientId: m.clientId, name: m.name, role: m.role, port: m.port, peerId: m.peerId,
      voice: !!m.voice, connected: !!m.connected, isHost: !!m.isHost,
      rtt: m.stats ? m.stats.rtt : null, tier: m.tierIdx != null ? TIERS[m.tierIdx].name : null,
    }));

    function broadcast() {
      const msg = { t: 'roster', roster: rosterData(), ...st };
      for (const m of members.values()) if (!m.isHost && m.connected && m.ctrl && m.ctrl.open) m.ctrl.send(msg);
      h.roster(msg);
      voice.sync(msg.roster, hostId);
    }

    function usedPorts() { return new Set([...members.values()].filter((m) => m.port != null).map((m) => m.port)); }
    function freePort() {
      const used = usedPorts();
      for (let p = 0; p < st.maxPorts; p++) if (!used.has(p)) return p;
      return null;
    }

    function onConn(conn) {
      const cid = conn.metadata && conn.metadata.clientId;
      if (!cid || cid === 'host') { conn.close(); return; }
      if (conn.label === 'input') {
        conn.on('data', (d) => {
          const m = members.get(cid);
          if (!m || !m.connected || m.port == null || !d) return;
          if (m.inputConn !== conn) { m.inputConn = conn; m.seq = -1; }
          if (d.s <= m.seq) return;
          m.seq = d.s;
          PS.emu.setInput(m.port, d);
        });
        return;
      }
      conn.on('data', (d) => onCtrl(conn, cid, d));
      conn.on('close', () => onClose(cid, conn));
      conn.on('error', () => onClose(cid, conn));
    }

    function onCtrl(conn, cid, d) {
      if (!d || !d.t) return;
      let m = members.get(cid);
      switch (d.t) {
        case 'hello': {
          const returning = !!m;
          if (m) {
            clearTimeout(m.expire);
            if (m.ctrl && m.ctrl !== conn) { const old = m.ctrl; m.ctrl = null; old.close(); }
          } else {
            if (st.locked) { conn.send({ t: 'denied', reason: 'This room is locked.' }); setTimeout(() => conn.close(), 400); return; }
            m = { clientId: cid, role: 'spectator', port: null, tierIdx: st.quality === 'auto' ? 1 : tierIndex(st.quality) };
            members.set(cid, m);
            if (d.want === 'player') { const p = freePort(); if (p != null) { m.role = 'player'; m.port = p; } }
          }
          Object.assign(m, { ctrl: conn, peerId: conn.peer, connected: true, voice: false, seq: -1, name: cleanName(d.name), goodStreak: 0, appliedTier: null, lastBytes: null });
          conn.send({ t: 'welcome', port: m.port, role: m.role });
          broadcast();
          if (st.running) callGuest(m);
          h.toast(returning ? `${m.name} is back` : `${m.name} joined${m.port != null ? ' as P' + (m.port + 1) : ' to watch'}`);
          break;
        }
        case 'ping': conn.send({ t: 'pong', ts: d.ts }); break;
        case 'voice': if (m) { m.voice = !!d.on; broadcast(); } break;
      }
    }

    function onClose(cid, conn) {
      const m = members.get(cid);
      if (!m || m.ctrl !== conn || !m.connected) return;
      m.connected = false; m.voice = false;
      if (m.call) { m.call.close(); m.call = null; }
      if (m.port != null) PS.emu.releaseAll(m.port);
      broadcast();
      h.toast(`${m.name} dropped${m.port != null ? ' \u2014 holding P' + (m.port + 1) : ''}`);
      m.expire = setTimeout(() => { if (!m.connected) { members.delete(cid); broadcast(); } }, 120000);
    }

    async function callGuest(m) {
      if (!m.peerId || !peer || !peer.open || !streamFactory) return;
      let stream;
      try { stream = await getStream(); }
      catch (e) { streamP = null; h.toast('This browser can\u2019t stream the game to friends.'); return; }
      if (!m.connected) return;
      if (m.call) m.call.close();
      const call = peer.call(m.peerId, stream, { metadata: { kind: 'game' } });
      m.call = call;
      m.appliedTier = null;
      call.on('close', () => { if (m.call === call) m.call = null; });
      call.on('error', () => { if (m.call === call) m.call = null; });
    }

    const tierIndex = (id) => Math.max(0, TIERS.findIndex((t) => t.id === id));

    async function applyTier(m, sender) {
      if (m.appliedTier === m.tierIdx) return;
      const t = TIERS[m.tierIdx];
      const base = Math.max(1, canvasW / 640);
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) return; // not negotiated yet; retry next tick
      Object.assign(p.encodings[0], { maxBitrate: t.br, scaleResolutionDownBy: base * t.scale, maxFramerate: t.fps });
      try {
        p.degradationPreference = 'maintain-framerate';
        await sender.setParameters(p);
      } catch (e) {
        try { delete p.degradationPreference; await sender.setParameters(p); } catch (e2) { return; }
      }
      m.appliedTier = m.tierIdx;
    }

    async function statsTick() {
      if (destroyed) return;
      const c = PS.emu.canvas && PS.emu.canvas();
      if (c && c.width) canvasW = c.width;
      for (const m of members.values()) {
        if (m.isHost || !m.connected || !m.call || !m.call.peerConnection) continue;
        const sender = m.call.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (!sender) continue;
        let rtt = null, loss = null, fps = null, kbps = null;
        try {
          (await sender.getStats()).forEach((r) => {
            if (r.type === 'remote-inbound-rtp' && r.kind === 'video') { rtt = r.roundTripTime; loss = r.fractionLost; }
            if (r.type === 'outbound-rtp' && r.kind === 'video') {
              fps = r.framesPerSecond;
              if (m.lastBytes != null && r.timestamp > m.lastTs) kbps = ((r.bytesSent - m.lastBytes) * 8) / (r.timestamp - m.lastTs);
              m.lastBytes = r.bytesSent; m.lastTs = r.timestamp;
            }
          });
        } catch (e) {}
        m.stats = {
          rtt: rtt != null ? Math.round(rtt * 1000) : (m.stats ? m.stats.rtt : null),
          loss: loss != null ? Math.round(loss * 100) : null,
          fps: fps ? Math.round(fps) : null,
          kbps: kbps ? Math.round(kbps) : null,
        };
        if (st.quality === 'auto') {
          const bad = (loss != null && loss > 0.06) || (rtt != null && rtt > 0.3);
          const good = (loss == null || loss < 0.015) && (rtt == null || rtt < 0.15);
          if (bad && m.tierIdx < TIERS.length - 1) { m.tierIdx++; m.goodStreak = 0; }
          else if (good) { if (++m.goodStreak >= 4 && m.tierIdx > 1) { m.tierIdx--; m.goodStreak = 0; } }
          else m.goodStreak = 0;
        } else m.tierIdx = tierIndex(st.quality);
        await applyTier(m, sender);
        if (m.ctrl && m.ctrl.open) m.ctrl.send({ t: 'q', tier: TIERS[m.tierIdx].name, ...m.stats });
      }
      h.stats(rosterData());
    }
    const statsTimer = setInterval(statsTick, 2000);
    const rosterTimer = setInterval(() => { if (members.size > 1) broadcast(); }, 6000);

    open();

    return {
      code, hostId, tiers: TIERS,
      get state() { return { ...st }; },
      get voiceOn() { return voice.on; },
      roster: rosterData,
      setRunning(factory) {
        streamFactory = factory; st.running = true;
        for (const m of members.values()) if (!m.isHost && m.connected) callGuest(m);
        broadcast();
      },
      setPort(cid, port) {
        const m = members.get(cid);
        if (!m) return;
        if (port != null) {
          const other = [...members.values()].find((o) => o !== m && o.port === port);
          if (other) { PS.emu.releaseAll(other.port); other.port = m.port; other.role = other.port == null ? 'spectator' : 'player'; }
        }
        if (m.port != null) PS.emu.releaseAll(m.port);
        m.port = port; m.role = port == null ? 'spectator' : 'player';
        broadcast();
      },
      kick(cid) {
        const m = members.get(cid);
        if (!m || m.isHost) return;
        clearTimeout(m.expire);
        if (m.ctrl && m.ctrl.open) m.ctrl.send({ t: 'kick' });
        setTimeout(() => m.ctrl && m.ctrl.close(), 250);
        if (m.call) m.call.close();
        if (m.port != null) PS.emu.releaseAll(m.port);
        members.delete(cid);
        broadcast();
      },
      setView(v) { st.view = v; broadcast(); },
      setPaused(b) { st.paused = !!b; broadcast(); },
      setLockViews(b) { st.lockViews = !!b; broadcast(); },
      setLocked(b) { st.locked = !!b; broadcast(); },
      setMaxPorts(n) {
        st.maxPorts = n;
        for (const m of members.values()) if (m.port != null && m.port >= n) { PS.emu.releaseAll(m.port); m.port = null; m.role = 'spectator'; }
        broadcast();
      },
      setQuality(q) {
        st.quality = q;
        for (const m of members.values()) { m.appliedTier = null; if (!m.isHost) m.tierIdx = q === 'auto' ? 1 : tierIndex(q); }
      },
      async voiceStart() { await voice.start(); self.voice = true; broadcast(); },
      voiceStop() { voice.stop(); self.voice = false; broadcast(); },
      unlockAudio() { voice.unlock(); },
      destroy() {
        destroyed = true;
        clearInterval(statsTimer); clearInterval(rosterTimer);
        for (const m of members.values()) if (m.ctrl && m.ctrl.open) m.ctrl.send({ t: 'ended' });
        voice.stop();
        setTimeout(() => peer && peer.destroy(), 300);
      },
    };
  }

  // =====================================================================
  // GUEST
  // =====================================================================
  function join(code, name, want, h) {
    const hostId = PREFIX + code.toUpperCase();
    let peer = null, ctrl = null, input = null, alive = true, tries = 0, retryT = null;
    let seq = 0, last = { b: 0, a: [0, 0, 0, 0] }, gameCall = null;
    let rtt = null, hostQ = {}, fps = null;
    const voice = new Voice();

    function newPeer() {
      try { if (peer) peer.destroy(); } catch (e) {}
      peer = new Peer(peerOpts());
      voice.peer = peer;
      voice.calls.clear();
      peer.on('open', connect);
      peer.on('call', (call) => {
        if (call.metadata && call.metadata.kind === 'game') {
          if (gameCall && gameCall !== call) gameCall.close();
          gameCall = call;
          call.answer();
          call.on('stream', (s) => h.stream(s));
        } else voice.incoming(call);
      });
      peer.on('disconnected', () => { if (alive && !peer.destroyed) setTimeout(() => peer.disconnected && !peer.destroyed && peer.reconnect(), 1000); });
      peer.on('error', (e) => {
        console.warn('[guest]', e.type, e);
        if (!alive) return;
        if (e.type === 'peer-unavailable') { h.status(tries > 1 ? 'Host isn\u2019t reachable \u2014 still trying\u2026' : 'Looking for the room\u2026'); retry(); }
        else if (SIGNAL_ERRORS.includes(e.type)) retry();
      });
    }

    function connect() {
      if (!alive) return;
      clearTimeout(retryT);
      if (ctrl) { const c = ctrl; ctrl = null; c.close(); }
      if (input) { const c = input; input = null; c.close(); }
      h.status(tries ? 'Reconnecting \u2014 your port is held\u2026' : 'Connecting\u2026');
      const meta = { clientId: PS.clientId };
      const c = (ctrl = peer.connect(hostId, { label: 'ctrl', reliable: true, serialization: 'json', metadata: meta }));
      input = peer.connect(hostId, { label: 'input', reliable: false, serialization: 'json', metadata: meta });
      c.on('open', () => { tries = 0; c.send({ t: 'hello', name, want }); });
      c.on('data', onData);
      c.on('close', () => { if (c === ctrl) lost(); });
      c.on('error', () => { if (c === ctrl) lost(); });
      setTimeout(() => { if (c === ctrl && !c.open) retry(); }, 10000);
    }

    function lost() { if (!alive) return; h.lost(); retry(); }
    function retry() {
      if (!alive) return;
      clearTimeout(retryT);
      const delay = Math.min(8000, 1000 * 2 ** Math.min(tries, 3));
      tries++;
      retryT = setTimeout(() => {
        if (peer && peer.open && !peer.destroyed) connect();
        else newPeer();
      }, delay);
    }

    function onData(d) {
      if (!d || !d.t) return;
      switch (d.t) {
        case 'welcome':
          h.status(null);
          h.welcome(d);
          if (voice.on) ctrl.send({ t: 'voice', on: true });
          send();
          break;
        case 'roster':
          h.roster(d);
          if (peer) voice.sync(d.roster, peer.id);
          break;
        case 'pong': rtt = Date.now() - d.ts; report(); break;
        case 'q': hostQ = d; report(); break;
        case 'kick': end('The host removed you from the room.'); break;
        case 'ended': end('The host ended the session.'); break;
        case 'denied': end(d.reason || 'The room refused the connection.'); break;
      }
    }
    function report() { h.stats({ rtt, fps, tier: hostQ.tier, loss: hostQ.loss }); }

    function end(msg) {
      alive = false;
      clearInterval(timer);
      voice.stop();
      h.ended(msg);
      setTimeout(() => { try { peer.destroy(); } catch (e) {} }, 300);
    }

    function send() {
      if (input && input.open) input.send({ s: ++seq, b: last.b, a: last.a.map((v) => Math.round(v * 1000) / 1000) });
    }
    let tick = 0;
    const timer = setInterval(async () => {
      send(); // heartbeat keeps state correct even if a packet was lost
      if (++tick % 10) return; // every 2 s
      if (ctrl && ctrl.open) ctrl.send({ t: 'ping', ts: Date.now() });
      if (gameCall && gameCall.peerConnection) {
        try {
          (await gameCall.peerConnection.getStats()).forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesPerSecond != null) fps = Math.round(r.framesPerSecond);
          });
        } catch (e) {}
      }
    }, 200);

    newPeer();

    return {
      sendInput(s) { last = s; send(); },
      get voiceOn() { return voice.on; },
      async voiceStart() { await voice.start(); if (ctrl && ctrl.open) ctrl.send({ t: 'voice', on: true }); },
      voiceStop() { voice.stop(); if (ctrl && ctrl.open) ctrl.send({ t: 'voice', on: false }); },
      unlockAudio() { voice.unlock(); },
      leave() { alive = false; clearInterval(timer); clearTimeout(retryT); voice.stop(); try { peer.destroy(); } catch (e) {} },
    };
  }

  PS.net = { createHost, join, TIERS };
})();
