/* Voice mesh with the host as broker.
   Everyone is already connected to the host, so the host passes connection messages
   (offers, answers, ICE candidates) between members. Each pair of people with mics on
   then talks peer-to-peer. No lobby server is involved, so this works for direct invites too.
   send(to, data) delivers a message to member `to`; handle(from, data) receives one. */
(function () {
  const PS = window.PS;

  class Mesh {
    constructor(selfId, send) {
      this.self = selfId;
      this.send = send;
      this.mic = null;
      this.pcs = new Map();
      this.audios = new Map();
      this.roster = [];
    }
    get on() { return !!this.mic; }

    async start() {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      this.sync(this.roster);
    }
    stop() {
      [...this.pcs.keys()].forEach((id) => { this.send(id, { bye: 1 }); this.drop(id); });
      if (this.mic) this.mic.getTracks().forEach((t) => t.stop());
      this.mic = null;
    }

    // Keep one connection per other member with voice on. The larger id places the call.
    sync(roster) {
      this.roster = roster || [];
      const live = new Set(this.roster.filter((m) => m.voice && m.connected && m.clientId !== this.self).map((m) => m.clientId));
      for (const id of [...this.pcs.keys()]) if (!live.has(id)) this.drop(id);
      if (!this.mic) return;
      for (const id of live) if (!this.pcs.has(id) && this.self > id) this.call(id);
    }

    make(id) {
      const pc = new RTCPeerConnection({ iceServers: PS.iceServers() });
      pc.pending = [];
      this.pcs.set(id, pc);
      pc.onicecandidate = (e) => { if (e.candidate) this.send(id, { c: e.candidate.toJSON() }); };
      pc.ontrack = (e) => this.play(id, e.streams[0] || new MediaStream([e.track]));
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && this.pcs.get(id) === pc) {
          this.drop(id);
          setTimeout(() => this.sync(this.roster), 3000); // try again
        }
      };
      if (this.mic) this.mic.getTracks().forEach((t) => pc.addTrack(t, this.mic));
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      return pc;
    }

    async call(id) {
      const pc = this.make(id);
      await pc.setLocalDescription(await pc.createOffer());
      this.send(id, { sdp: pc.localDescription.toJSON() });
    }

    async handle(from, d) {
      try {
        let pc = this.pcs.get(from);
        if (d.bye) { this.drop(from); return; }
        if (d.sdp) {
          if (d.sdp.type === 'offer') {
            if (pc) this.drop(from);
            pc = this.make(from);
            await pc.setRemoteDescription(d.sdp);
            await pc.setLocalDescription(await pc.createAnswer());
            this.send(from, { sdp: pc.localDescription.toJSON() });
          } else if (pc) await pc.setRemoteDescription(d.sdp);
          if (pc) { for (const c of pc.pending) await pc.addIceCandidate(c).catch(() => {}); pc.pending = []; }
        } else if (d.c && pc) {
          if (pc.remoteDescription) await pc.addIceCandidate(d.c).catch(() => {});
          else pc.pending.push(d.c);
        }
      } catch (e) { console.warn('[mesh]', e); }
    }

    drop(id) {
      const pc = this.pcs.get(id);
      if (pc) { try { pc.close(); } catch (e) {} this.pcs.delete(id); }
      const a = this.audios.get(id);
      if (a) { a.srcObject = null; a.remove(); this.audios.delete(id); }
    }

    play(id, stream) {
      let a = this.audios.get(id);
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true; a.playsInline = true;
        document.body.appendChild(a);
        this.audios.set(id, a);
      }
      a.srcObject = stream;
      a.play().catch(() => PS.needsTap && PS.needsTap());
    }
    unlock() { this.audios.forEach((a) => a.play().catch(() => {})); }
    peers() { return [...this.pcs.keys()]; }
  }

  PS.Mesh = Mesh;
})();
