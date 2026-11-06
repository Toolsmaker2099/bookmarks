// Sauvegarde vers le worker Cloudflare KV.
// Format par défaut : GET <url> renvoie le coffre chiffré (JSON), PUT <url> l'enregistre.
// Le corps est TOUJOURS chiffré : le worker et Cloudflare ne voient que du bruit.

function headers(cfg, extra = {}) {
  const h = { ...extra };
  if (cfg.header && cfg.value) h[cfg.header] = cfg.value;
  return h;
}

export function isConfigured(cfg) { return !!(cfg && cfg.url); }

export function metaConfig(cfg) {
  if (!cfg?.meta) return null;
  return { url: cfg.meta, headers: headers(cfg) };
}

export async function pull(cfg) {
  const r = await fetch(cfg.url, { method: 'GET', headers: headers(cfg), cache: 'no-store', credentials: 'omit' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Lecture refusée (HTTP ${r.status})`);
  const text = await r.text();
  if (!text.trim()) return null;
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Réponse du worker illisible'); }
  // Tolère un worker qui enveloppe la valeur : { value: "..." } ou { data: {...} }
  if (j && j.app !== 'coffre-liens') {
    const inner = j.value ?? j.data ?? j.result;
    if (inner) j = typeof inner === 'string' ? JSON.parse(inner) : inner;
  }
  if (!j || j.app !== 'coffre-liens') throw new Error("La clé KV ne contient pas une sauvegarde de l'app");
  return j;
}

export async function push(cfg, vault) {
  const r = await fetch(cfg.url, {
    method: cfg.method || 'PUT', headers: headers(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(vault), cache: 'no-store', credentials: 'omit',
  });
  if (!r.ok) throw new Error(`Écriture refusée (HTTP ${r.status})`);
}
