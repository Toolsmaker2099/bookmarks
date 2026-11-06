// Sauvegarde en ligne chiffrée (service « sauvegarde » de toolsmaker).
// URL attendue : https://<worker>/v1/bookmarks/XXXX-XXXX-XXXX-XXXX  (le code est dans l'URL).
// GET -> coffre chiffré (404 si absent) ; PUT -> enregistre. Le corps est TOUJOURS chiffré.
// Contrôle de version : en-tête X-Sauvegarde-Version ("new" ou version connue) -> 409 si modifié ailleurs.
const HDR = 'X-Sauvegarde-Version';
let lastVersion = null; // null = inconnue, '' = n'existe pas encore

function headers(cfg, extra = {}) {
  const h = { ...extra };
  if (cfg.header && cfg.value) h[cfg.header] = cfg.value;
  return h;
}
export function isConfigured(cfg) { return !!(cfg && cfg.url); }
export function metaConfig(cfg) { return cfg?.meta ? { url: cfg.meta, headers: headers(cfg) } : null; }

export function generateCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(16));
  const c = [...b].map(x => A[x % A.length]).join('');
  return c.match(/.{4}/g).join('-');
}

export async function pull(cfg) {
  const r = await fetch(cfg.url, { method: 'GET', headers: headers(cfg), cache: 'no-store', credentials: 'omit' });
  if (r.status === 404) { lastVersion = ''; return null; }
  if (r.status === 429) throw new Error('Trop de requêtes, réessaie dans quelques minutes.');
  if (r.status === 403) throw new Error('Ce site n\'est pas autorisé par le service de sauvegarde (' + location.origin + ').');
  if (!r.ok) throw new Error(`Lecture refusée (HTTP ${r.status})`);
  lastVersion = r.headers.get(HDR) || '';
  const text = await r.text();
  if (!text.trim()) return null;
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Réponse illisible du service de sauvegarde'); }
  if (!j || j.app !== 'coffre-liens') throw new Error("Ce code contient autre chose qu'une sauvegarde de cette app");
  return j;
}

// force=true : écrase sans contrôle de version.
export async function push(cfg, vault, { force = false } = {}) {
  const h = headers(cfg, { 'Content-Type': 'application/json' });
  if (!force && lastVersion !== null) h[HDR] = lastVersion || 'new';
  const r = await fetch(cfg.url, { method: 'PUT', headers: h, body: JSON.stringify(vault), cache: 'no-store', credentials: 'omit' });
  if (r.status === 409) { const e = new Error('CONFLICT'); throw e; }
  if (r.status === 413) throw new Error('Sauvegarde trop grosse pour le service en ligne.');
  if (r.status === 429) throw new Error('Trop de requêtes, réessaie dans quelques minutes.');
  if (r.status === 403) throw new Error('Ce site n\'est pas autorisé par le service de sauvegarde (' + location.origin + ').');
  if (!r.ok) throw new Error(`Écriture refusée (HTTP ${r.status})`);
  lastVersion = r.headers.get(HDR) || lastVersion;
}
