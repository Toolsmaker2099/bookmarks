// Worker Cloudflare de référence pour l'app Signets (KV).
// Liaison KV : BACKUP  |  Secrets : TOKEN (obligatoire), ALLOWED_ORIGIN (ex. https://toolsmaker2099.github.io)
// Routes : GET/PUT /backup  -> coffre chiffré ; GET /meta?url=... -> { title, image } (pour les aperçus)
const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400', 'Vary': 'Origin',
});
const json = (o, env, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (!env.TOKEN || req.headers.get('Authorization') !== `Bearer ${env.TOKEN}`) return json({ error: 'unauthorized' }, env, 401);
    const url = new URL(req.url);

    if (url.pathname === '/backup') {
      if (req.method === 'GET') {
        const v = await env.BACKUP.get('vault');
        return v ? new Response(v, { headers: { 'Content-Type': 'application/json', ...cors(env) } }) : json({ error: 'empty' }, env, 404);
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await req.text();
        if (body.length > 20 * 1024 * 1024) return json({ error: 'too large' }, env, 413);
        try { if (JSON.parse(body).app !== 'coffre-liens') throw 0; } catch { return json({ error: 'bad payload' }, env, 400); }
        await env.BACKUP.put('vault', body);
        return json({ ok: true }, env);
      }
    }

    if (url.pathname === '/meta' && req.method === 'GET') {
      const target = url.searchParams.get('url');
      try {
        const t = new URL(target);
        if (!/^https?:$/.test(t.protocol)) throw 0;
        const r = await fetch(t, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SignetsBot/1.0)', 'Accept-Language': 'fr,en;q=0.8' }, redirect: 'follow' });
        const meta = {};
        await new HTMLRewriter()
          .on('meta', { element(e) {
            const k = e.getAttribute('property') || e.getAttribute('name'), c = e.getAttribute('content');
            if (k && c && !meta[k]) meta[k] = c;
          } })
          .on('title', { text(t2) { meta._title = (meta._title || '') + t2.text; } })
          .transform(r).arrayBuffer();
        const abs = (u) => { try { return new URL(u, t).href; } catch { return ''; } };
        return json({
          title: (meta['og:title'] || meta['twitter:title'] || meta._title || '').trim().slice(0, 300),
          image: abs(meta['og:image'] || meta['twitter:image'] || ''),
          video: !!(meta['og:video'] || meta['og:video:url'] || /video/.test(meta['og:type'] || '')),
        }, env);
      } catch { return json({ title: '', image: '' }, env); }
    }
    return json({ error: 'not found' }, env, 404);
  },
};
