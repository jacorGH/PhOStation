/**
 * PhoStation relay Worker (Cloudflare Workers, free plan).
 *
 * Hands PhoStation short-lived logins for Cloudflare's TURN relay, so your Cloudflare
 * key never leaves this Worker. Only someone with your ACCESS_CODE gets logins.
 *
 * Settings (Worker > Settings > Variables and Secrets):
 *   TURN_KEY_ID         the "Turn Token ID" from Realtime > TURN Server
 *   TURN_KEY_API_TOKEN  the "API Token" from the same page        (add as a Secret)
 *   ACCESS_CODE         any password you choose                   (add as a Secret)
 * Optional:
 *   ALLOWED_ORIGIN      e.g. https://yourname.github.io  (limits which site may ask)
 *
 * Request:  GET https://<worker>.workers.dev/?code=<ACCESS_CODE>[&ttl=seconds]
 * Response: { "iceServers": [...], "ttl": 86400 }
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()) : ['*'];
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !env.ACCESS_CODE) {
      return reply({ error: 'The Worker is missing TURN_KEY_ID, TURN_KEY_API_TOKEN or ACCESS_CODE.' }, 500);
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code') || '';
    if (!(await same(code, env.ACCESS_CODE))) return reply({ error: 'Wrong access code.' }, 401);

    // Cloudflare allows up to 48 hours; a day covers any session.
    const ttl = Math.min(172800, Math.max(600, parseInt(url.searchParams.get('ttl'), 10) || 86400));
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
    });
    if (!res.ok) return reply({ error: `Cloudflare refused the TURN key (${res.status}). Check TURN_KEY_ID and TURN_KEY_API_TOKEN.` }, 502);

    const data = await res.json();
    // The API has returned both a single object and a list over time; accept either.
    const servers = [].concat(data.iceServers || [])
      .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) })) // browsers block port 53
      .filter((s) => s.urls.length);
    return reply({ iceServers: servers, ttl });
  },
};

// Compare without leaking timing.
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest('SHA-256', enc.encode(v))));
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}
