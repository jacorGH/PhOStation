/* Connection check: is peer-to-peer possible from this network, and what kind of NAT is in the way?
   Asks several STUN servers how this device looks from the internet. If the router hands out a
   different public port for each server, it's a strict ("symmetric") NAT that defeats hole punching. */
(function () {
  const PS = window.PS;
  const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

  function parse(c) {
    // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> [raddr x rport y]
    const p = c.candidate.split(' ');
    const get = (k) => { const i = p.indexOf(k); return i > 0 ? p[i + 1] : null; };
    return { protocol: (p[2] || '').toLowerCase(), address: p[4], port: +p[5], type: get('typ'), raddr: get('raddr'), rport: +get('rport') };
  }

  async function gather(config, ms = 6000) {
    const pc = new RTCPeerConnection(config);
    const out = [];
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) out.push(parse(e.candidate)); };
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((res) => {
      const t = setTimeout(res, ms);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } };
    });
    pc.close();
    return out;
  }

  function lobby(ms = 8000) {
    return new Promise((res) => {
      if (typeof Peer === 'undefined') return res(false);
      let p;
      const t = setTimeout(() => { try { p.destroy(); } catch (e) {} res(false); }, ms);
      try {
        p = new Peer({ debug: 0 });
        p.on('open', () => { clearTimeout(t); p.destroy(); res(true); });
        p.on('error', () => { clearTimeout(t); try { p.destroy(); } catch (e) {} res(false); });
      } catch (e) { clearTimeout(t); res(false); }
    });
  }

  const isV4 = (a) => /^\d+\.\d+\.\d+\.\d+$/.test(a);

  // onStep(key, state, detail) is called as each check finishes.
  async function run(onStep = () => {}) {
    const r = {};
    onStep('lobby', 'run');
    const lobbyP = lobby().then((ok) => { r.lobby = ok; onStep('lobby', ok ? 'ok' : 'bad'); });

    onStep('nat', 'run');
    const cands = await gather({ iceServers: STUN.map((urls) => ({ urls })) });
    const host = cands.filter((c) => c.type === 'host');
    const srflx = cands.filter((c) => c.type === 'srflx' && c.protocol === 'udp');
    r.lan = host.length > 0;
    r.udp = srflx.length > 0;
    r.publicIps = [...new Set(srflx.map((c) => c.address))];
    // Same public IPv4 address but different ports for different servers = symmetric NAT.
    const byAddr = {};
    srflx.filter((c) => isV4(c.address)).forEach((c) => (byAddr[c.address] = byAddr[c.address] || new Set()).add(c.port));
    r.symmetric = Object.values(byAddr).some((ports) => ports.size > 1);
    r.ipv6 = srflx.some((c) => !isV4(c.address)) || host.some((c) => c.address && c.address.includes(':'));
    r.nat = !r.udp ? 'blocked' : r.symmetric ? 'strict' : 'open';
    onStep('nat', r.nat === 'open' ? 'ok' : r.nat === 'strict' ? 'warn' : 'bad');

    const relays = PS.ice.relayServers(false);
    if (relays.length) {
      onStep('turn', 'run');
      const relay = await gather({ iceServers: relays, iceTransportPolicy: 'relay' }, 8000);
      r.turn = relay.some((c) => c.type === 'relay');
      onStep('turn', r.turn ? 'ok' : 'bad');
    } else r.turn = null;

    await lobbyP;
    return r;
  }

  // Plain-language verdict and advice.
  function verdict(r) {
    const tips = [];
    let level, title;
    if (r.nat === 'open') {
      level = 'ok'; title = 'Peer-to-peer works here';
      tips.push('Your router lets direct connections through, so you can host or join.');
    } else if (r.nat === 'strict') {
      level = 'warn'; title = 'Strict NAT: direct connections are hit and miss';
      tips.push('Your router changes ports for every connection. You can connect to friends with an open NAT, but two strict NATs usually can\u2019t reach each other.');
      tips.push('Best fixes: let the friend with an open NAT host, switch networks (Wi-Fi vs cellular), or set up your free relay in Settings.');
    } else {
      level = 'bad'; title = 'This network blocks peer-to-peer';
      tips.push('Direct connections (UDP) can\u2019t get out. Try a different network (Wi-Fi vs cellular), or add a TURN relay in Settings that uses TCP port 443.');
    }
    if (r.nat !== 'open' && r.lan) tips.push('Friends on the same Wi-Fi can still connect straight across your local network with a direct invite.');
    if (r.turn === true) tips.push('Your TURN relay works, so friends can always connect through it as a fallback.');
    if (r.turn === false) tips.push('Your TURN relay didn\u2019t answer. Check its settings, or tap Save and test in Settings.');
    if (!r.lobby) tips.push('The lobby server can\u2019t be reached, so room codes won\u2019t work. Use a direct invite code instead.');
    return { level, title, tips };
  }

  PS.nettest = { run, verdict };
})();
