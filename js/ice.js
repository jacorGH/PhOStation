/* Which STUN/TURN servers connections use.
   - STUN (always): lets each side learn its public address for hole punching.
   - Your relay: either a fixed TURN server (prefs.turn) or your Cloudflare Worker
     (prefs.relayWorker), which hands out short-lived Cloudflare TURN logins.
   - A relay shared by the host in an invite, used only for that session. */
(function () {
  const PS = window.PS;
  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const CACHE_KEY = 'phostation.relayCache';

  let cache = null; // { servers, exp }
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
  let guest = null;

  // Browsers block port 53; drop those URLs.
  const clean = (s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) });

  function relayServers(includeShared = true) {
    const out = [];
    const t = PS.prefs.turn;
    if (t && t.url) out.push({ urls: t.url.split(',').map((x) => x.trim()).filter(Boolean), username: t.user || '', credential: t.pass || '' });
    if (PS.prefs.relayWorker && PS.prefs.relayWorker.url && cache && cache.exp > Date.now()) out.push(...cache.servers);
    if (guest && includeShared) out.push(...guest);
    return out.map(clean).filter((s) => s.urls.length);
  }

  // Fetch fresh Cloudflare TURN logins from your Worker when the cached ones are under an hour from expiring.
  async function refresh(force) {
    const w = PS.prefs.relayWorker;
    if (!w || !w.url) return false;
    if (!force && cache && cache.exp - Date.now() > 3600e3) return true;
    const url = w.url.replace(/\/+$/, '') + (w.url.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(w.code || '');
    let r, j;
    try { r = await fetch(url); j = await r.json(); }
    catch (e) { throw new Error('Your relay Worker couldn\u2019t be reached. Check its address.'); }
    if (!r.ok) throw new Error(j && j.error ? j.error : `Your relay Worker answered ${r.status}.`);
    const servers = [].concat(j.iceServers || []).filter((s) => s && s.username);
    if (!servers.length) throw new Error('Your relay Worker didn\u2019t return any TURN logins.');
    cache = { servers, exp: Date.now() + (j.ttl || 86400) * 1000 };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
    return true;
  }

  // What goes into an invite when sharing your relay: just the two most useful addresses.
  function shareable() {
    if (!PS.prefs.shareRelay) return null;
    const list = relayServers(false);
    if (!list.length) return null;
    return list.slice(0, 2).map((s) => {
      const urls = s.urls.filter((u) => /^turn:.*:3478(\?transport=udp)?$/.test(u) || /^turns:.*:443/.test(u));
      return { urls: urls.length ? urls : s.urls.slice(0, 2), username: s.username, credential: s.credential };
    });
  }

  PS.ice = {
    servers: () => STUN.concat(relayServers()),
    relayServers,
    refresh,
    shareable,
    useShared(list) { guest = Array.isArray(list) && list.length ? list.map(clean) : null; },
    clearCache() { cache = null; try { localStorage.removeItem(CACHE_KEY); } catch (e) {} },
  };
  PS.iceServers = PS.ice.servers;
})();
