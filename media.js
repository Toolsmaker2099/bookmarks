// Détection du type de lien, miniatures et lecteurs intégrés.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv|m3u8)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|flac|m4a|aac|opus)(\?|#|$)/i;

function u(url) { try { return new URL(url); } catch { return null; } }
const host = (x) => x.hostname.replace(/^(www|m)\./, '');

// Retourne { type, provider, id, embed, thumb, oembed } pour une URL.
export function analyze(url) {
  const x = u(url);
  if (!x) return { type: 'page' };
  const h = host(x);
  let m;

  // YouTube
  if (h === 'youtu.be') m = x.pathname.slice(1);
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(h)) {
    m = x.searchParams.get('v') || (x.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/) || [])[1];
  }
  if (m && /^[\w-]{6,}$/.test(m)) {
    const t = x.searchParams.get('t');
    const start = t ? parseInt(t, 10) : 0;
    return {
      type: h === 'music.youtube.com' ? 'audio' : 'video', provider: 'YouTube', id: m,
      embed: `https://www.youtube-nocookie.com/embed/${m}?autoplay=1&rel=0${start ? '&start=' + start : ''}`,
      thumb: `https://i.ytimg.com/vi/${m}/hqdefault.jpg`,
    };
  }
  // Vimeo
  if (h === 'vimeo.com' && (m = x.pathname.match(/\/(\d{5,})/))) {
    return { type: 'video', provider: 'Vimeo', id: m[1], embed: `https://player.vimeo.com/video/${m[1]}?autoplay=1&dnt=1`,
      oembed: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}` };
  }
  // Dailymotion
  if ((h === 'dailymotion.com' && (m = x.pathname.match(/\/video\/([a-z0-9]+)/i))) || (h === 'dai.ly' && (m = x.pathname.match(/\/([a-z0-9]+)/i)))) {
    return { type: 'video', provider: 'Dailymotion', id: m[1], embed: `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1`,
      thumb: `https://www.dailymotion.com/thumbnail/video/${m[1]}` };
  }
  // Twitch (VOD / clips)
  if (h === 'twitch.tv' && (m = x.pathname.match(/\/videos\/(\d+)/))) {
    return { type: 'video', provider: 'Twitch', id: m[1], embed: `https://player.twitch.tv/?video=${m[1]}&parent=${location.hostname}` };
  }
  // Sites adultes courants (lecteur intégré officiel ; la miniature passe par le worker)
  if (h.endsWith('pornhub.com') && (m = x.searchParams.get('viewkey'))) {
    return { type: 'video', provider: 'Pornhub', id: m, embed: `https://www.pornhub.com/embed/${m}` };
  }
  if (h.endsWith('xvideos.com') && (m = x.pathname.match(/\/video\.?([a-z0-9]+)\//i))) {
    return { type: 'video', provider: 'XVideos', id: m[1], embed: `https://www.xvideos.com/embedframe/${m[1]}` };
  }
  if (h.endsWith('xhamster.com') && (m = x.pathname.match(/\/videos\/.*-([a-z0-9]+)$/i))) {
    return { type: 'video', provider: 'xHamster', id: m[1], embed: `https://xhamster.com/xembed.php?video=${m[1]}` };
  }
  if (h.endsWith('redtube.com') && (m = x.pathname.match(/^\/(\d+)/))) {
    return { type: 'video', provider: 'RedTube', id: m[1], embed: `https://embed.redtube.com/?id=${m[1]}` };
  }
  // Audio
  if (h === 'soundcloud.com' && x.pathname.split('/').filter(Boolean).length >= 2) {
    return { type: 'audio', provider: 'SoundCloud', embed: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true`,
      oembed: `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}` };
  }
  if (h === 'open.spotify.com' && (m = x.pathname.match(/\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/))) {
    return { type: 'audio', provider: 'Spotify', embed: `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
      oembed: `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}` };
  }
  if (h === 'deezer.com' && (m = x.pathname.match(/\/(track|album|playlist|episode)\/(\d+)/))) {
    return { type: 'audio', provider: 'Deezer', embed: `https://widget.deezer.com/widget/dark/${m[1]}/${m[2]}` };
  }
  if (h.endsWith('bandcamp.com')) return { type: 'audio', provider: 'Bandcamp' };
  // Fichiers directs
  if (VIDEO_EXT.test(x.pathname)) return { type: 'video', provider: 'Fichier', direct: 'video' };
  if (AUDIO_EXT.test(x.pathname)) return { type: 'audio', provider: 'Fichier', direct: 'audio' };
  return { type: 'page' };
}

async function getJson(url, opts = {}) {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', ...opts });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Récupère titre + miniature. `meta` = config du worker ({ url, headers }) ou null.
export async function fetchPreview(url, meta) {
  const a = analyze(url);
  const out = { type: a.type, title: '', thumb: a.thumb || '' };
  if (a.oembed) {
    try { const j = await getJson(a.oembed); out.title = j.title || ''; out.thumb = out.thumb || j.thumbnail_url || ''; } catch {}
  }
  if (a.provider === 'YouTube') {
    // oEmbed YouTube n'envoie pas d'en-têtes CORS : le titre vient du worker s'il est configuré.
  }
  if (meta?.url && (!out.title || !out.thumb)) {
    try {
      const j = await getJson(meta.url.replace('{url}', encodeURIComponent(url)), { headers: meta.headers });
      out.title = out.title || j.title || '';
      out.thumb = out.thumb || j.image || '';
      if (a.type === 'page' && j.video) out.type = 'video';
    } catch {}
  }
  return out;
}

// Extrait une URL d'un texte partagé (Android met souvent l'URL dans "text").
export function extractUrl(...parts) {
  for (const p of parts) {
    if (!p) continue;
    const m = String(p).match(/https?:\/\/[^\s<>"']+/i);
    if (m) return m[0].replace(/[).,;!?]+$/, '');
  }
  return '';
}

export function domainOf(url) { const x = u(url); return x ? host(x) : url; }
