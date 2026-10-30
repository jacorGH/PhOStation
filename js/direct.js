/* Direct connect: no lobby server. The host makes an invite code containing its connection
   details (IP addresses, ports, keys); the friend answers with a reply code containing theirs.
   WebRTC then punches through both NATs the same way Hamachi-style tools do.
   Each invite is for one friend. */
(function () {
  const PS = window.PS;

  // ---------- code format: PHO1z.<base64url(deflate(json))>  (PHO1j. = uncompressed) ----------
  const b64u = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64u = (s) => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };
  async function pipe(u8, T) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(T)).arrayBuffer()); }

  async function encode(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== 'undefined') return 'PHO1z.' + b64u(await pipe(raw, new CompressionStream('deflate-raw')));
    return 'PHO1j.' + b64u(raw);
  }
  async function decode(text) {
    const m = String(text || '').replace(/\s+/g, '').match(/PHO1([zj])\.([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('That isn\u2019t a PhoStation code. Copy the whole thing.');
    let u8 = unb64u(m[2]);
    if (m[1] === 'z') {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to read compressed codes. Update iOS or use Chrome.');
      u8 = await pipe(u8, new DecompressionStream('deflate-raw'));
    }
    return JSON.parse(new TextDecoder().decode(u8));
  }
  const findCode = (text) => { const m = String(text || '').replace(/\s+/g, '').match(/PHO1[zj]\.[A-Za-z0-9_-]+/); return m ? m[0] : null; };

  // All candidates go into the code at once, so wait for gathering to finish.
  function waitGather(pc, ms = 5000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }

  // PeerJS-style wrapper around an RTCDataChannel, so the netplay code can treat both the same.
  function wrap(dc, label, peer, metadata) {
    const hs = {};
    const emit = (ev, ...a) => (hs[ev] || []).forEach((f) => f(...a));
    let closed = false;
    const fireClose = () => { if (!closed) { closed = true; emit('close'); } };
    dc.onopen = () => emit('open');
    dc.onmessage = (e) => { try { emit('data', JSON.parse(e.data)); } catch (err) {} };
    dc.onclose = fireClose;
    dc.onerror = () => emit('error');
    return {
      label, peer, metadata, _fireClose: fireClose,
      get open() { return dc.readyState === 'open'; },
      on(ev, f) { (hs[ev] = hs[ev] || []).push(f); if (ev === 'open' && dc.readyState === 'open') f(); },
      send(d) { if (dc.readyState === 'open') dc.send(JSON.stringify(d)); },
      close() { try { dc.close(); } catch (e) {} },
    };
  }

  function playVoice(track) {
    const a = document.createElement('audio');
    a.autoplay = true; a.playsInline = true;
    a.srcObject = new MediaStream([track]);
    document.body.appendChild(a);
    a.play().catch(() => PS.needsTap && PS.needsTap());
    track.addEventListener('ended', () => a.remove());
    return a;
  }

  // ---------- host side ----------
  // Returns { code, accept(replyCode) -> link }. The link plugs into the host like a PeerJS guest.
  async function hostInvite() {
    const pc = new RTCPeerConnection({ iceServers: PS.iceServers() });
    const vt = pc.addTransceiver('video', { direction: 'sendonly' });
    const at = pc.addTransceiver('audio', { direction: 'sendonly' });
    const voiceT = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const ctrlDc = pc.createDataChannel('ctrl', { ordered: true });
    const inputDc = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
    await pc.setLocalDescription(await pc.createOffer());
    await waitGather(pc);
    const code = await encode({ v: 1, k: 'offer', sdp: pc.localDescription.sdp, vm: voiceT.mid });
    let voiceEl = null;
    pc.ontrack = (e) => { if (e.transceiver === voiceT) voiceEl = playVoice(e.track); };

    return {
      code,
      pc,
      async accept(replyText) {
        const a = await decode(replyText);
        if (a.k !== 'answer') throw new Error('That\u2019s an invite code. Paste the reply your friend sent back.');
        await pc.setRemoteDescription({ type: 'answer', sdp: a.sdp });
        const meta = { clientId: a.cid };
        const peerId = 'direct-' + a.cid;
        const link = {
          pc,
          media: { peerConnection: pc, close() {} },
          setStream(s) {
            vt.sender.replaceTrack(s.getVideoTracks()[0] || null);
            at.sender.replaceTrack(s.getAudioTracks()[0] || null);
          },
          setMic(mic) { voiceT.sender.replaceTrack(mic ? mic.getAudioTracks()[0] : null); },
          close() { try { pc.close(); } catch (e) {} if (voiceEl) voiceEl.remove(); },
        };
        const ctrl = wrap(ctrlDc, 'ctrl', peerId, meta);
        const input = wrap(inputDc, 'input', peerId, meta);
        ctrl.direct = link;
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') ctrl._fireClose();
        });
        return { ctrl, input, link };
      },
    };
  }

  // ---------- guest side ----------
  async function guestReply(inviteText, clientId) {
    const o = await decode(inviteText);
    if (o.k !== 'offer') throw new Error('That\u2019s a reply code. Paste the invite from the host.');
    const pc = new RTCPeerConnection({ iceServers: PS.iceServers() });
    const stream = new MediaStream();
    const handlers = {};
    let voiceEl = null;
    pc.ontrack = (e) => {
      if (e.transceiver && e.transceiver.mid === o.vm) { voiceEl = playVoice(e.track); return; }
      stream.addTrack(e.track);
      handlers.stream && handlers.stream(stream);
    };
    const channels = new Promise((res) => {
      const got = {};
      pc.ondatachannel = (e) => {
        got[e.channel.label] = wrap(e.channel, e.channel.label, 'host', {});
        if (got.ctrl && got.input) res(got);
      };
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
    const voiceT = pc.getTransceivers().find((t) => t.mid === o.vm);
    if (voiceT) voiceT.direction = 'sendrecv';
    await pc.setLocalDescription(await pc.createAnswer());
    await waitGather(pc);
    const code = await encode({ v: 1, k: 'answer', sdp: pc.localDescription.sdp, cid: clientId });
    return {
      code, pc, channels,
      onStream(f) { handlers.stream = f; if (stream.getTracks().length) f(stream); },
      setMic(mic) { if (voiceT) voiceT.sender.replaceTrack(mic ? mic.getAudioTracks()[0] : null); },
      close() { try { pc.close(); } catch (e) {} if (voiceEl) voiceEl.remove(); },
    };
  }

  // ---------- which path a live connection took ----------
  // 'LAN' (same network), 'Direct' (punched through NAT) or 'Relay' (via TURN).
  async function pathType(pc) {
    try {
      const st = await pc.getStats();
      let pair = null;
      st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
      if (!pair) st.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (!pair) return null;
      const l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId);
      const types = [l && l.candidateType, r && r.candidateType];
      if (types.includes('relay')) return 'Relay';
      if (types.every((t) => t === 'host')) return 'LAN';
      return 'Direct';
    } catch (e) { return null; }
  }

  PS.direct = { hostInvite, guestReply, decode, findCode, pathType };
})();
