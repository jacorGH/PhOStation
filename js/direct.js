/* Direct connect: no lobby server. The host's invite code carries its connection details
   (IP addresses, ports, encryption fingerprint); the friend's reply code carries theirs.
   WebRTC then punches through both NATs, like Hamachi-style tools. One invite per friend.

   Codes are kept short:
   - video is limited to H.264 (hardware-encoded on iPhone) and VP8, audio to Opus;
   - the invite's session description is tokenised with a fixed dictionary, then compressed;
   - addresses are packed as [type, address, port] instead of full candidate lines;
   - the reply only carries the friend's login, fingerprint and addresses; the host rebuilds
     the rest from its own invite. */
(function () {
  const PS = window.PS;

  // ---------- encoding helpers ----------
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
  const pipe = async (u8, T) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(T)).arrayBuffer());

  async function pack(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== 'undefined') return 'PHO2.' + b64u(await pipe(raw, new CompressionStream('deflate-raw')));
    return 'PHO2j.' + b64u(raw);
  }
  const CODE_RE = /PHO2(j?)\.([A-Za-z0-9_-]+)/;
  const findCode = (text) => { const m = String(text || '').replace(/\s+/g, '').match(CODE_RE); return m ? m[0] : null; };
  async function unpack(text) {
    const m = String(text || '').replace(/\s+/g, '').match(CODE_RE);
    if (!m) throw new Error('That isn\u2019t a PhoStation code. Copy the whole thing (it starts with PHO2).');
    let u8 = unb64u(m[2]);
    if (!m[1]) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to read compressed codes. Update iOS or use Chrome.');
      u8 = await pipe(u8, new DecompressionStream('deflate-raw'));
    }
    return JSON.parse(new TextDecoder().decode(u8));
  }

  // ---------- SDP dictionary (append-only: both sides must share it) ----------
  const DICT = [
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\n', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\n',
    'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\n', 'https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension\n',
    'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\n', 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay\n',
    'http://www.webrtc.org/experiments/rtp-hdrext/video-content-type\n', 'http://www.webrtc.org/experiments/rtp-hdrext/video-timing\n',
    'http://www.webrtc.org/experiments/rtp-hdrext/color-space\n', 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time\n',
    'http://www.webrtc.org/experiments/rtp-hdrext/video-layers-allocation00\n', 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id\n',
    'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\n', 'urn:ietf:params:rtp-hdrext:ssrc-audio-level\n', 'urn:ietf:params:rtp-hdrext:csrc-audio-level\n',
    'urn:ietf:params:rtp-hdrext:sdes:mid\n', 'urn:ietf:params:rtp-hdrext:toffset\n', 'urn:3gpp:video-orientation\n',
    'm=video 9 UDP/TLS/RTP/SAVPF ', 'm=audio 9 UDP/TLS/RTP/SAVPF ', 'a=rtcp:9 IN IP4 0.0.0.0\n', 'c=IN IP4 0.0.0.0\n',
    ' 2 IN IP4 127.0.0.1\ns=-\nt=0 0\n', 'a=max-message-size:262144\n', 'a=sctp-port:5000\n', 'a=ice-options:trickle\n',
    'a=fingerprint:sha-256 ', 'a=setup:actpass\n', 'a=msid-semantic: WMS', 'a=extmap-allow-mixed\n', 'a=group:BUNDLE ',
    'minptime=10;useinbandfec=1\n', 'a=ssrc-group:FID ', 'a=rtcp-rsize\n', 'a=rtcp-mux\n', 'a=sendonly\n', 'a=recvonly\n', 'a=sendrecv\n',
    'a=ice-ufrag:', 'a=ice-pwd:', 'a=rtcp-fb:', 'a=rtpmap:', 'a=extmap:', 'a=fmtp:', 'a=ssrc:', 'a=msid:', 'a=mid:', ' cname:',
    ' goog-remb\n', ' transport-cc\n', ' ccm fir\n', ' nack pli\n', ' nack\n', 'H264/90000\n', 'VP8/90000\n', 'rtx/90000\n',
    'opus/48000/2\n', 'apt=', 'v=0\no=- ', 'urn:ietf:params:rtp-hdrext:', 'http://www.webrtc.org/experiments/rtp-hdrext/',
  ];
  const TOK = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const ORDER = DICT.map((w, i) => [w, TOK[i]]).sort((a, b) => b[0].length - a[0].length);

  function squeeze(sdp) {
    const t = sdp.replace(/\r\n/g, '\n');
    let out = '';
    for (let i = 0; i < t.length;) {
      if (t[i] === '~') { out += '~~'; i++; continue; }
      const hit = ORDER.find(([w]) => t.startsWith(w, i));
      if (hit) { out += '~' + hit[1]; i += hit[0].length; } else out += t[i++];
    }
    return out;
  }
  function expand(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '~') { out += s[i]; continue; }
      const c = s[++i];
      out += c === '~' ? '~' : DICT[TOK.indexOf(c)];
    }
    return out.replace(/\n/g, '\r\n');
  }

  // ---------- candidates: [type, address, port, relatedAddress?, relatedPort?] ----------
  const TYPES = { host: 'h', srflx: 's', prflx: 'p', relay: 'r' };
  const NAMES = { h: 'host', s: 'srflx', p: 'prflx', r: 'relay' };
  const PREF = { h: 126, p: 110, s: 100, r: 0 };
  function takeCandidates(sdp) {
    const seen = new Set(), out = [];
    for (const line of sdp.split(/\r?\n/)) {
      if (!line.startsWith('a=candidate:')) continue;
      const p = line.slice(12).split(' ');
      if ((p[2] || '').toLowerCase() !== 'udp') continue; // UDP only (relay candidates are UDP too)
      const typ = TYPES[p[p.indexOf('typ') + 1]];
      if (!typ) continue;
      const key = typ + p[4] + ':' + p[5];
      if (seen.has(key)) continue;
      seen.add(key);
      const c = [typ, p[4], +p[5]];
      const ra = p.indexOf('raddr');
      if (ra > 0 && typ !== 'h') c.push(p[ra + 1], +p[p.indexOf('rport') + 1]);
      out.push(c);
    }
    return out;
  }
  const stripCandidates = (sdp) => sdp.split('\r\n').filter((l) => !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates').join('\r\n');
  function candidateLine(c, i) {
    const [typ, addr, port, raddr, rport] = c;
    const prio = (PREF[typ] << 24) + ((65535 - i) << 8) + 255;
    return `candidate:${i + 1} 1 udp ${prio >>> 0} ${addr} ${port} typ ${NAMES[typ]}${raddr ? ` raddr ${raddr} rport ${rport}` : ''} generation 0`;
  }
  async function addCandidates(pc, list, mid) {
    for (let i = 0; i < list.length; i++) {
      try { await pc.addIceCandidate({ candidate: candidateLine(list[i], i), sdpMid: mid, sdpMLineIndex: 0 }); } catch (e) {}
    }
  }

  const sdpValue = (sdp, key) => { const m = sdp.match(new RegExp('^a=' + key + ':(.+?)\\r?$', 'm')); return m ? m[1].trim() : null; };

  // Answer for the host, rebuilt from its own offer plus the friend's login and fingerprint.
  // Directions are mirrored and the host's own stream ids are dropped.
  function answerFromOffer(offer, a) {
    const fp = a.f.toUpperCase().match(/../g).join(':');
    return offer.split('\r\n').filter(Boolean).map((l) => {
      if (l.startsWith('o=')) return `o=- ${Date.now()}${Math.floor(Math.random() * 1e6)} 2 IN IP4 127.0.0.1`;
      if (l.startsWith('a=ice-ufrag:')) return 'a=ice-ufrag:' + a.u;
      if (l.startsWith('a=ice-pwd:')) return 'a=ice-pwd:' + a.p;
      if (l.startsWith('a=fingerprint:')) return 'a=fingerprint:sha-256 ' + fp;
      if (l.startsWith('a=setup:')) return 'a=setup:' + (a.r || 'active');
      if (l === 'a=sendonly') return 'a=recvonly';
      if (l === 'a=recvonly') return 'a=sendonly';
      if (l.startsWith('a=ssrc') || l.startsWith('a=msid:')) return null;
      return l;
    }).filter((l) => l !== null).join('\r\n') + '\r\n';
  }

  // All addresses go into the code at once, so wait for gathering to finish.
  function waitGather(pc, ms = 5000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }

  // H.264 first (hardware encoding on iPhone), VP8 as fallback; Opus for audio. Fewer codecs, shorter code.
  function preferCodecs(tr, kind) {
    try {
      if (!tr.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
      const caps = RTCRtpReceiver.getCapabilities(kind).codecs;
      const keep = kind === 'video'
        ? [
          ...caps.filter((c) => c.mimeType === 'video/H264' && /packetization-mode=1/.test(c.sdpFmtpLine || '') && /profile-level-id=42e01f/i.test(c.sdpFmtpLine || '')).slice(0, 1),
          ...caps.filter((c) => c.mimeType === 'video/VP8').slice(0, 1),
          ...caps.filter((c) => c.mimeType === 'video/rtx'),
        ]
        : caps.filter((c) => c.mimeType === 'audio/opus').slice(0, 1);
      if (keep.some((c) => c.mimeType !== 'video/rtx')) tr.setCodecPreferences(keep);
    } catch (e) { /* keep the browser's defaults */ }
  }

  // PeerJS-style wrapper around an RTCDataChannel, so the netplay code treats both the same.
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

  // ---------- host side ----------
  async function hostInvite(hostName) {
    const pc = new RTCPeerConnection({ iceServers: PS.iceServers() });
    const vt = pc.addTransceiver('video', { direction: 'sendonly' });
    const at = pc.addTransceiver('audio', { direction: 'sendonly' });
    preferCodecs(vt, 'video');
    preferCodecs(at, 'audio');
    const ctrlDc = pc.createDataChannel('ctrl', { ordered: true });
    const inputDc = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
    await pc.setLocalDescription(await pc.createOffer());
    await waitGather(pc);
    const sdp = pc.localDescription.sdp;
    const offer = stripCandidates(sdp);
    const relay = PS.ice.shareable();
    const code = await pack({ k: 'o', s: squeeze(offer), c: takeCandidates(sdp), n: (hostName || '').slice(0, 16), ...(relay ? { x: relay } : {}) });

    return {
      code, pc, sharedRelay: !!relay,
      async accept(replyText) {
        const a = await unpack(replyText);
        if (a.k !== 'a') throw new Error('That\u2019s an invite code. Paste the reply your friend sent back.');
        await pc.setRemoteDescription({ type: 'answer', sdp: answerFromOffer(offer, a) });
        await addCandidates(pc, a.c || [], sdpValue(offer, 'mid'));
        const meta = { clientId: a.cid };
        const peerId = 'direct-' + a.cid;
        const link = {
          pc,
          media: { peerConnection: pc, close() {} },
          setStream(s) {
            vt.sender.replaceTrack(s.getVideoTracks()[0] || null);
            at.sender.replaceTrack(s.getAudioTracks()[0] || null);
          },
          close() { try { pc.close(); } catch (e) {} },
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
    const o = await unpack(inviteText);
    if (o.k !== 'o') throw new Error('That\u2019s a reply code. Paste the invite from the host.');
    if (o.x) PS.ice.useShared(o.x); // the host's relay, for this session only
    const pc = new RTCPeerConnection({ iceServers: PS.iceServers() });
    const stream = new MediaStream();
    const handlers = {};
    pc.ontrack = (e) => { stream.addTrack(e.track); handlers.stream && handlers.stream(stream); };
    const channels = new Promise((res) => {
      const got = {};
      pc.ondatachannel = (e) => {
        got[e.channel.label] = wrap(e.channel, e.channel.label, 'host', {});
        if (got.ctrl && got.input) res(got);
      };
    });
    const offer = expand(o.s);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer });
    await addCandidates(pc, o.c || [], sdpValue(offer, 'mid'));
    await pc.setLocalDescription(await pc.createAnswer());
    await waitGather(pc);
    const ans = pc.localDescription.sdp;
    const code = await pack({
      k: 'a', cid: clientId,
      u: sdpValue(ans, 'ice-ufrag'), p: sdpValue(ans, 'ice-pwd'),
      f: (sdpValue(ans, 'fingerprint') || '').split(' ').pop().replace(/:/g, ''),
      r: sdpValue(ans, 'setup') || 'active',
      c: takeCandidates(ans),
    });
    return {
      code, pc, channels, hostName: o.n || '', usesSharedRelay: !!o.x,
      onStream(f) { handlers.stream = f; if (stream.getTracks().length) f(stream); },
      close() { try { pc.close(); } catch (e) {} },
    };
  }

  // ---------- which path a live connection took: LAN, Direct or Relay ----------
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

  // Relay logins packed for room-code invite links.
  const packRelay = (list) => pack({ k: 'r', x: list });
  async function unpackRelay(text) { const r = await unpack(text); return r.k === 'r' ? r.x : null; }

  PS.direct = { hostInvite, guestReply, findCode, pathType, packRelay, unpackRelay, _squeeze: squeeze, _expand: expand };
})();
