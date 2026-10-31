/* PhoStation netplay.
   Host runs the emulator and streams video+audio to every guest. Guests send controller state back.
   Voice is a mesh between everyone with the mic on, brokered by the host (see mesh.js). */
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

  const peerOpts = () => ({ debug: 1, config: { iceServers: PS.iceServers() } });
  const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';

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
    // The host is the broker: voice connection messages between members go through here.
    const mesh = new PS.Mesh('host', (to, d) => {
      const m = members.get(to);
      if (m && m.connected && m.ctrl && m.ctrl.open) m.ctrl.send({ t: 'sig', from: 'host', d });
    });

    function open() {
      peer = new Peer(hostId, peerOpts());
      peer.on('open', () => h.status('ready'));
      peer.on('connection', onConn);
      peer.on('call', (call) => call.close());
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
      path: m.stats ? m.stats.path : null, direct: !!m.direct,
    }));

    function broadcast() {
      const msg = { t: 'roster', roster: rosterData(), ...st };
      for (const m of members.values()) if (!m.isHost && m.connected && m.ctrl && m.ctrl.open) m.ctrl.send(msg);
      h.roster(msg);
      mesh.sync(msg.roster);
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
          if (m) m.lastSeen = Date.now();
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
      if (m) m.lastSeen = Date.now();
      switch (d.t) {
        case 'hello': {
          // Same person on a new connection id (app reopened, storage cleared): recognise them by
          // name if their old slot is held or has gone silent, so they get their port back.
          if (!m) {
            const nm = cleanName(d.name).toLowerCase();
            const held = [...members.values()].find((x) => !x.isHost && x.name && x.name.toLowerCase() === nm
              && (!x.connected || Date.now() - (x.lastSeen || 0) > 4000));
            if (held) {
              members.delete(held.clientId);
              held.clientId = cid;
              members.set(cid, held);
              m = held;
            }
          }
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
          Object.assign(m, { ctrl: conn, peerId: conn.peer, connected: true, voice: false, seq: -1, lastSeen: Date.now(), name: cleanName(d.name), goodStreak: 0, appliedTier: null, lastBytes: null });
          if (m.direct && m.direct !== conn.direct) m.direct.close();
          m.direct = conn.direct || null;
          conn.send({ t: 'welcome', port: m.port, role: m.role });
          broadcast();
          if (st.running) callGuest(m);
          h.toast(returning ? `${m.name} is back` : `${m.name} joined${m.port != null ? ' as P' + (m.port + 1) : ' to watch'}`);
          break;
        }
        case 'ping': conn.send({ t: 'pong', ts: d.ts }); break;
        case 'voice': if (m) { m.voice = !!d.on; broadcast(); } break;
        case 'sig': // broker: pass voice connection messages along
          if (!m || !d.to) break;
          if (d.to === 'host') mesh.handle(cid, d.d);
          else {
            const t = members.get(d.to);
            if (t && t.connected && t.ctrl && t.ctrl.open) t.ctrl.send({ t: 'sig', from: cid, d: d.d });
          }
          break;
      }
    }

    function onClose(cid, conn) {
      const m = members.get(cid);
      if (!m || m.ctrl !== conn || !m.connected) return;
      dropMember(m);
    }
    function dropMember(m) {
      if (!m.connected) return;
      m.connected = false; m.voice = false;
      if (m.ctrl) { const c = m.ctrl; m.ctrl = null; try { c.close(); } catch (e) {} }
      if (m.call) { m.call.close(); m.call = null; }
      if (m.direct) { m.direct.close(); m.direct = null; }
      if (m.port != null) PS.emu.releaseAll(m.port);
      broadcast();
      h.toast(`${m.name} dropped${m.port != null ? ' \u2014 holding P' + (m.port + 1) : ''}`);
      m.expire = setTimeout(() => { if (!m.connected && members.get(m.clientId) === m) { members.delete(m.clientId); broadcast(); } }, 120000);
    }

    async function callGuest(m) {
      if (!streamFactory) return;
      if (!m.direct && (!m.peerId || !peer || !peer.open)) return;
      let stream;
      try { stream = await getStream(); }
      catch (e) { streamP = null; h.toast('This browser can\u2019t stream the game to friends.'); return; }
      if (!m.connected) return;
      if (m.direct) { m.direct.setStream(stream); m.call = m.direct.media; m.appliedTier = null; return; }
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
      for (const m of members.values()) {
        if (!m.isHost && m.connected && m.lastSeen && Date.now() - m.lastSeen > 10000) dropMember(m);
      }
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
        const path = await PS.direct.pathType(m.call.peerConnection);
        m.stats = {
          path,
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
      get voiceOn() { return mesh.on; },
      roster: rosterData,
      setRunning(factory) {
        streamFactory = factory; st.running = true;
        for (const m of members.values()) if (!m.isHost && m.connected) callGuest(m);
        broadcast();
      },
      // New game: switch everyone's video and audio to the new emulator without reconnecting.
      async swapStream(factory) {
        streamFactory = factory;
        if (!streamP) return; // nobody was watching yet; the stream is made on demand
        streamP = Promise.resolve().then(factory);
        let s;
        try { s = await streamP; } catch (e) { streamP = null; return; }
        const tracks = { video: s.getVideoTracks()[0] || null, audio: s.getAudioTracks()[0] || null };
        for (const m of members.values()) {
          if (m.isHost || !m.connected) continue;
          m.appliedTier = null;
          if (m.direct) { m.direct.setStream(s); continue; }
          const pc = m.call && m.call.peerConnection;
          if (!pc) { callGuest(m); continue; }
          const senders = pc.getSenders();
          const kinds = new Set(senders.filter((x) => x.track).map((x) => x.track.kind));
          if ((tracks.audio && !kinds.has('audio')) || (tracks.video && !kinds.has('video'))) { callGuest(m); continue; }
          for (const snd of senders) if (snd.track && tracks[snd.track.kind]) snd.replaceTrack(tracks[snd.track.kind]).catch(() => callGuest(m));
        }
      },
      notify(msg) { for (const m of members.values()) if (!m.isHost && m.connected && m.ctrl && m.ctrl.open) m.ctrl.send({ t: 'note', msg }); },
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
      async voiceStart() { await mesh.start(); self.voice = true; broadcast(); },
      voiceStop() { mesh.stop(); self.voice = false; broadcast(); },
      // Lobby-free invite for one friend: hand them invite.code, then paste their reply into accept().
      async directInvite() {
        const inv = await PS.direct.hostInvite(self.name);
        return {
          code: inv.code, pc: inv.pc, sharedRelay: inv.sharedRelay,
          async accept(text) {
            const { ctrl, input } = await inv.accept(text);
            onConn(input);
            onConn(ctrl);
          },
        };
      },
      unlockAudio() { mesh.unlock(); },
      destroy() {
        destroyed = true;
        clearInterval(statsTimer); clearInterval(rosterTimer);
        for (const m of members.values()) if (m.ctrl && m.ctrl.open) m.ctrl.send({ t: 'ended' });
        mesh.stop();
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
    let rtt = null, hostQ = {}, fps = null, path = null;
    const mesh = new PS.Mesh(PS.clientId, (to, d) => { if (ctrl && ctrl.open) ctrl.send({ t: 'sig', to, d }); });

    function newPeer() {
      try { if (peer) peer.destroy(); } catch (e) {}
      peer = new Peer(peerOpts());
      peer.on('open', connect);
      peer.on('call', (call) => {
        if (call.metadata && call.metadata.kind === 'game') {
          if (gameCall && gameCall !== call) gameCall.close();
          gameCall = call;
          call.answer();
          call.on('stream', (s) => h.stream(s));
        } else call.close();
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

    let lastHeard = 0;
    function onData(d) {
      if (!d || !d.t) return;
      lastHeard = Date.now();
      switch (d.t) {
        case 'welcome':
          h.status(null);
          h.welcome(d);
          if (mesh.on) ctrl.send({ t: 'voice', on: true });
          send();
          break;
        case 'roster':
          h.roster(d);
          mesh.sync(d.roster);
          break;
        case 'sig': mesh.handle(d.from, d.d); break;
        case 'pong': rtt = Date.now() - d.ts; report(); break;
        case 'q': hostQ = d; report(); break;
        case 'note': h.note && h.note(d.msg); break;
        case 'kick': end('The host removed you from the room.'); break;
        case 'ended': end('The host ended the session.'); break;
        case 'denied': end(d.reason || 'The room refused the connection.'); break;
      }
    }
    function report() { h.stats({ rtt, fps, tier: hostQ.tier, loss: hostQ.loss, path }); }

    function end(msg) {
      alive = false;
      clearInterval(timer);
      mesh.stop();
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
      // The host pings back every 2 s; 10 s of silence means the link is dead even if it looks open.
      if (ctrl && ctrl.open && lastHeard && Date.now() - lastHeard > 10000) { lastHeard = 0; lost(); return; }
      if (ctrl && ctrl.open) ctrl.send({ t: 'ping', ts: Date.now() });
      if (gameCall && gameCall.peerConnection) {
        path = await PS.direct.pathType(gameCall.peerConnection);
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
      get voiceOn() { return mesh.on; },
      async voiceStart() { await mesh.start(); if (ctrl && ctrl.open) ctrl.send({ t: 'voice', on: true }); },
      voiceStop() { mesh.stop(); if (ctrl && ctrl.open) ctrl.send({ t: 'voice', on: false }); },
      unlockAudio() { mesh.unlock(); },
      leave() { alive = false; clearInterval(timer); clearTimeout(retryT); mesh.stop(); try { peer.destroy(); } catch (e) {} },
    };
  }

  // =====================================================================
  // GUEST over a direct link (no lobby server)
  // =====================================================================
  function joinDirect(inviteText, name, want, h) {
    let link = null, ctrl = null, input = null, alive = true;
    let seq = 0, last = { b: 0, a: [0, 0, 0, 0] }, rtt = null, hostQ = {}, fps = null, path = null;
    const mesh = new PS.Mesh(PS.clientId, (to, d) => { if (ctrl && ctrl.open) ctrl.send({ t: 'sig', to, d }); });

    const end = (msg) => {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      mesh.stop();
      h.ended(msg);
      setTimeout(() => link && link.close(), 300);
    };
    const report = () => h.stats({ rtt, fps, tier: hostQ.tier, loss: hostQ.loss, path });
    const send = () => { if (input && input.open) input.send({ s: ++seq, b: last.b, a: last.a.map((v) => Math.round(v * 1000) / 1000) }); };

    function onData(d) {
      if (!d || !d.t) return;
      switch (d.t) {
        case 'welcome': h.status(null); h.welcome(d); if (mesh.on) ctrl.send({ t: 'voice', on: true }); send(); break;
        case 'roster': h.roster(d); mesh.sync(d.roster); break;
        case 'sig': mesh.handle(d.from, d.d); break;
        case 'pong': rtt = Date.now() - d.ts; report(); break;
        case 'q': hostQ = d; report(); break;
        case 'note': h.note && h.note(d.msg); break;
        case 'kick': end('The host removed you from the room.'); break;
        case 'ended': end('The host ended the session.'); break;
        case 'denied': end(d.reason || 'The room refused the connection.'); break;
      }
    }

    (async () => {
      try {
        h.status('Making your reply code…');
        link = await PS.direct.guestReply(inviteText, PS.clientId);
        if (!alive) return link.close();
        h.reply(link.code);
        h.status('Send your reply code to the host, then wait here.');
        link.onStream((s) => h.stream(s));
        link.pc.addEventListener('connectionstatechange', () => {
          const st = link.pc.connectionState;
          if (st === 'connecting') h.status('Connecting directly…');
          if (st === 'failed') end('The direct connection failed. Both networks may have strict NAT. Run the connection check, or add a TURN relay in Settings.');
        });
        const ch = await link.channels;
        ctrl = ch.ctrl; input = ch.input;
        ctrl.on('open', () => ctrl.send({ t: 'hello', name, want }));
        ctrl.on('data', onData);
        ctrl.on('close', () => end('The direct connection closed. Ask the host for a new invite code; your port is held for 2 minutes.'));
      } catch (err) {
        end(err.message || 'That invite code didn\u2019t work.');
      }
    })();

    let tick = 0;
    const timer = setInterval(async () => {
      send();
      if (++tick % 10 || !link) return;
      if (ctrl && ctrl.open) ctrl.send({ t: 'ping', ts: Date.now() });
      path = await PS.direct.pathType(link.pc);
      try {
        (await link.pc.getStats()).forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesPerSecond != null) fps = Math.round(r.framesPerSecond);
        });
      } catch (e) {}
    }, 200);

    return {
      sendInput(s) { last = s; send(); },
      get voiceOn() { return mesh.on; },
      async voiceStart() { await mesh.start(); if (ctrl && ctrl.open) ctrl.send({ t: 'voice', on: true }); },
      voiceStop() { mesh.stop(); if (ctrl && ctrl.open) ctrl.send({ t: 'voice', on: false }); },
      unlockAudio() { mesh.unlock(); },
      leave() { alive = false; clearInterval(timer); mesh.stop(); if (link) link.close(); },
    };
  }

  PS.net = { createHost, join, joinDirect, TIERS };
})();
