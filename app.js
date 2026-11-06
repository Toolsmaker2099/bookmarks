import { createVault, unlockVault, sealVault, rewrapVault, decryptJson } from './crypto.js';
import { analyze, fetchPreview, extractUrl, domainOf } from './media.js';
import * as sync from './sync.js';

const VERSION = '__VERSION__'; // remplacé au déploiement (numéro + commit)
const LS_KEY = 'signets.vault.v1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- État (uniquement en mémoire) ----------
let vault = null;   // blob chiffré tel que stocké
let dek = null;     // clé de données (CryptoKey non extractible)
let data = null;    // contenu déchiffré
let pendingShare = null;
let filter = { type: '', tag: '', q: '', sort: 'new' };
let showSensitive = false;
let lockTimer = null, hiddenAt = 0, syncTimer = null, syncing = false;

const defaultSettings = () => ({
  autoLock: 5, lockOnHide: false, blurAll: false,
  backup: { url: '', header: '', value: '', meta: '', auto: true },
  updatedAt: 0,
});
const emptyData = () => ({ items: [], tombstones: {}, settings: defaultSettings() });
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

// ---------- Stockage local ----------
function loadLocal() { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } }
function saveLocalBlob(v) { localStorage.setItem(LS_KEY, JSON.stringify(v)); }
async function persist({ syncSoon = true } = {}) {
  vault = await sealVault(vault, dek, data);
  saveLocalBlob(vault);
  if (syncSoon && data.settings.backup.auto && sync.isConfigured(data.settings.backup)) scheduleSync();
}

// ---------- Utilitaires UI ----------
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
const svg = (path) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = `<path d="${path}"/>`; return s; };
const ICONS = {
  play: 'M8 5v14l11-7z',
  audio: 'M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z',
  page: 'M6 2h8l6 6v14H6V2zm7 1.5V9h5.5',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
};
function showOnly(id) { for (const f of ['unlockForm', 'setupChoice', 'createForm', 'restoreForm']) $('#' + f).hidden = f !== id; }
function setBusy(on, msg = 'Calcul de la clé…') { $('#busy').hidden = !on; $('#busy').textContent = msg; $$('#lock button').forEach(b => b.disabled = on); }

function openUrl(item) {
  item.visits = (item.visits || 0) + 1; item.lastOpened = Date.now();
  persist({ syncSoon: false });
  const w = window.open(item.url, '_blank', 'noopener,noreferrer');
  if (!w) location.href = item.url; // bloqueur de popup (PWA iOS) : on ouvre ici
}

// ---------- Verrouillage ----------
function showLock() {
  $('#app').hidden = true; $('#lock').hidden = false;
  vault = loadLocal();
  if (vault) { showOnly('unlockForm'); setTimeout(() => $('#unlockPw').focus(), 50); }
  else showOnly('setupChoice');
}

function lock() {
  dek = null; data = null;
  $('#grid').replaceChildren(); $('#tagChips').replaceChildren();
  $$('dialog[open]').forEach(d => d.close());
  $('#player').replaceChildren();
  $('#unlockPw').value = ''; $('#unlockErr').textContent = '';
  showLock();
}

function bumpActivity() {
  if (!data) return;
  clearTimeout(lockTimer);
  const min = +data.settings.autoLock;
  if (min > 0) lockTimer = setTimeout(lock, min * 60000);
}
['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(ev => addEventListener(ev, bumpActivity, { passive: true }));

document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('veiled', document.hidden);
  if (!data) return;
  if (document.hidden) {
    hiddenAt = Date.now();
    if (data.settings.lockOnHide) lock();
  } else {
    const min = +data.settings.autoLock;
    if (min > 0 && Date.now() - hiddenAt > min * 60000) lock();
    else { bumpActivity(); if (sync.isConfigured(data.settings.backup) && data.settings.backup.auto) syncNow({ quiet: true }); }
  }
});
// Double Échap = verrouillage panique
let lastEsc = 0;
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !data) return;
  if (Date.now() - lastEsc < 500) lock(); lastEsc = Date.now();
});

async function enterApp() {
  $('#lock').hidden = true; $('#app').hidden = false;
  $('#unlockPw').value = '';
  bumpActivity(); render();
  if (pendingShare) { const s = pendingShare; pendingShare = null; openEditor(null, s); }
}

// ---------- Création / ouverture ----------
function passwordHint(pw) {
  if (!pw) return '';
  if (pw.length < 6) return 'Au moins 6 caractères.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter(r => r.test(pw)).length;
  if (pw.length < 10 || classes < 2) return 'Correct pour l’appareil, mais pour protéger la sauvegarde cloud, une phrase de 4–5 mots ou 12+ caractères est bien plus sûre.';
  return 'Bon mot de passe.';
}

$('#goCreate').onclick = () => { showOnly('createForm'); $('#createPw').focus(); };
$('#goRestore').onclick = () => showOnly('restoreForm');
$$('#lock .back').forEach(b => b.onclick = () => showOnly(loadLocal() ? 'unlockForm' : 'setupChoice'));
$('#createPw').oninput = (e) => { $('#pwHint').textContent = passwordHint(e.target.value); };
$('#forgotBtn').onclick = () => toast('Impossible de le récupérer : les données sont chiffrées avec. Tu peux effacer le coffre depuis les réglages… une fois connecté, ou vider les données du site.', 6000);

$('#createForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, err = $('.error', f);
  const pw = $('#createPw').value;
  if (pw !== $('#createPw2').value) { err.textContent = 'Les mots de passe ne correspondent pas.'; return; }
  if (pw.length < 6) { err.textContent = 'Au moins 6 caractères.'; return; }
  setBusy(true);
  try {
    data = emptyData();
    ({ vault, dek } = await createVault(pw, data));
    saveLocalBlob(vault);
    offerToSave(pw);
    f.reset(); $('#pwHint').textContent = '';
    await enterApp();
    toast('Coffre créé. Pense à configurer la sauvegarde dans les réglages.', 4000);
  } catch (ex) { err.textContent = 'Erreur : ' + ex.message; }
  finally { setBusy(false); }
};

// Aide les gestionnaires de mots de passe à proposer l'enregistrement (formulaire sans rechargement de page).
function offerToSave(pw) {
  try {
    if (window.PasswordCredential && navigator.credentials?.store)
      navigator.credentials.store(new PasswordCredential({ id: 'coffre', name: 'Safe Bookmarks', password: pw })).catch(() => {});
  } catch {}
}
let failures = 0;
$('#unlockForm').onsubmit = async (e) => {
  e.preventDefault();
  const pw = $('#unlockPw').value;
  $('#unlockErr').textContent = '';
  setBusy(true);
  try {
    if (failures >= 3) await new Promise(r => setTimeout(r, Math.min(30, 2 ** (failures - 2)) * 1000));
    const r = await unlockVault(vault, pw);
    dek = r.dek; data = normalize(r.data); failures = 0;
    await enterApp();
    if (sync.isConfigured(data.settings.backup)) syncNow({ quiet: true, password: pw });
  } catch (ex) {
    failures++;
    $('#unlockErr').textContent = ex.message === 'BAD_PASSWORD' ? 'Mot de passe incorrect.' : 'Erreur : ' + ex.message;
    $('#unlockPw').select();
  } finally { setBusy(false); }
};

$('#restoreForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, err = $('.error', f); err.textContent = '';
  const cfg = { ...defaultSettings().backup, url: f.url.value.trim() };
  setBusy(true, 'Téléchargement…');
  try {
    const remote = await sync.pull(cfg);
    if (!remote) throw new Error('Aucune sauvegarde trouvée à cette adresse.');
    setBusy(true);
    const r = await unlockVault(remote, f.password.value);
    vault = remote; dek = r.dek; data = normalize(r.data);
    if (!sync.isConfigured(data.settings.backup)) data.settings.backup = cfg;
    await persist({ syncSoon: false });
    f.reset();
    await enterApp();
    toast(`${data.items.length} favoris restaurés.`);
  } catch (ex) {
    err.textContent = ex.message === 'BAD_PASSWORD' ? 'Mot de passe incorrect pour cette sauvegarde.' :
      (ex instanceof TypeError ? 'Sauvegarde en ligne injoignable (adresse incorrecte ou accès refusé).' : ex.message);
  } finally { setBusy(false); }
};

function normalize(d) {
  d = { ...emptyData(), ...d };
  d.settings = { ...defaultSettings(), ...d.settings, backup: { ...defaultSettings().backup, ...(d.settings?.backup || {}) } };
  d.items = (d.items || []).filter(i => i && i.id && i.url);
  d.tombstones = d.tombstones || {};
  return d;
}

// ---------- Synchronisation (fusion par élément, le plus récent gagne) ----------
function merge(a, b) {
  const tomb = { ...a.tombstones };
  for (const [id, t] of Object.entries(b.tombstones || {})) tomb[id] = Math.max(tomb[id] || 0, t);
  const map = new Map();
  for (const it of [...a.items, ...(b.items || [])]) {
    const cur = map.get(it.id);
    if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) map.set(it.id, it);
  }
  const items = [...map.values()].filter(it => !(tomb[it.id] >= (it.updatedAt || 0)));
  // On garde les tombes 90 jours
  const cutoff = Date.now() - 90 * 864e5;
  for (const id in tomb) if (tomb[id] < cutoff) delete tomb[id];
  const sa = a.settings, sb = b.settings || sa;
  const settings = (sb.updatedAt || 0) > (sa.updatedAt || 0) ? sb : sa;
  return normalize({ items, tombstones: tomb, settings });
}
const digest = (d) => JSON.stringify([d.items.map(i => i.id + ':' + i.updatedAt).sort(), Object.keys(d.tombstones).sort(), d.settings.updatedAt]);

function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow({ quiet: true }), 1500); }

function syncBar(msg, kind = '') {
  const b = $('#syncBar'); b.hidden = !msg; b.textContent = msg || ''; b.className = 'syncbar ' + kind;
}

async function syncNow({ quiet = false, password = null, forcePush = false, retry = 0 } = {}) {
  if (!data || syncing) return;
  const cfg = data.settings.backup;
  if (!sync.isConfigured(cfg)) return;
  syncing = true;
  try {
    const remote = await sync.pull(cfg);
    let remoteData = null;
    if (remote) {
      try { remoteData = normalize(await decryptJson(dek, remote.data)); }
      catch {
        // Autre clé : la sauvegarde vient d'un autre coffre (ou d'un changement de mot de passe).
        if (!password) throw new Error('La sauvegarde distante est protégée par un autre mot de passe. Reverrouille puis rouvre avec ce mot de passe, ou utilise « Sauvegarder maintenant » pour l’écraser.');
        const r = await unlockVault(remote, password); // lève BAD_PASSWORD si différent
        remoteData = normalize(r.data);
        dek = r.dek; vault = { ...remote }; // on adopte la clé de la sauvegarde
      }
      // Le mot de passe a pu changer ailleurs : on adopte l'enveloppe distante si la clé est la même.
      if ((remote.updatedAt || 0) > (vault.updatedAt || 0)) vault = { ...vault, kdf: remote.kdf, wk: remote.wk };
    }
    const merged = remoteData ? merge(data, remoteData) : data;
    const changedLocal = digest(merged) !== digest(data);
    data = merged;
    if (changedLocal || !remote) { vault = await sealVault(vault, dek, data); saveLocalBlob(vault); render(); }
    if (forcePush || !remote || digest(merged) !== digest(remoteData)) {
      try { await sync.push(cfg, vault); }
      catch (ex) {
        if (ex.message !== 'CONFLICT' || retry >= 2) throw ex;
        syncing = false; return syncNow({ quiet, password, retry: retry + 1 }); // modifié ailleurs entre-temps : on refusionne
      }
    }
    if (remote && vault.updatedAt < remote.updatedAt) saveLocalBlob(vault);
    syncBar('');
    if (!quiet) toast('Synchronisé ✓');
    return true;
  } catch (ex) {
    const msg = ex instanceof TypeError ? 'Sauvegarde injoignable (réseau ou CORS).' : (ex.message === 'BAD_PASSWORD' ? 'La sauvegarde distante utilise un autre mot de passe.' : ex.message);
    syncBar('⚠ ' + msg, 'warn');
    if (!quiet) toast(msg, 5000);
    return false;
  } finally { syncing = false; }
}
addEventListener('online', () => data && syncNow({ quiet: true }));

// ---------- Rendu ----------
function visibleItems() {
  const q = filter.q.trim().toLowerCase();
  let list = data.items.filter(i =>
    (showSensitive || !i.sensitive) &&
    (!filter.type || i.type === filter.type) &&
    (!filter.tag || (i.tags || []).includes(filter.tag)) &&
    (!q || [i.title, i.url, i.note, ...(i.tags || [])].join(' ').toLowerCase().includes(q)));
  const by = {
    new: (a, b) => b.createdAt - a.createdAt, old: (a, b) => a.createdAt - b.createdAt,
    title: (a, b) => (a.title || a.url).localeCompare(b.title || b.url, 'fr'),
    visits: (a, b) => (b.visits || 0) - (a.visits || 0),
  };
  return list.sort(by[filter.sort]);
}

function render() {
  if (!data) return;
  const pool = data.items.filter(i => showSensitive || !i.sensitive);
  for (const c of $$('#typeChips .chip')) {
    const t = c.dataset.type; c.classList.toggle('on', t === filter.type);
    $('span', c).textContent = pool.filter(i => !t || i.type === t).length;
  }
  $('#sensBtn').setAttribute('aria-pressed', showSensitive);
  $('#sensBtn').classList.toggle('on', showSensitive);

  const tags = [...new Set(pool.flatMap(i => i.tags || []))].sort((a, b) => a.localeCompare(b, 'fr'));
  if (filter.tag && !tags.includes(filter.tag)) filter.tag = '';
  $('#tagChips').replaceChildren(...tags.map(t => el('button', {
    class: 'chip small' + (t === filter.tag ? ' on' : ''), text: '#' + t,
    onclick: () => { filter.tag = filter.tag === t ? '' : t; render(); },
  })));
  $('#tagList').replaceChildren(...tags.map(t => el('option', { value: t })));

  const items = visibleItems();
  $('#grid').replaceChildren(...items.map(card));
  const e = $('#empty');
  e.hidden = items.length > 0;
  e.textContent = data.items.length ? 'Aucun favori ne correspond.' : 'Aucun favori pour l’instant. Appuie sur + ou partage une page vers l’app depuis ton navigateur.';
  document.body.classList.toggle('blur-all', !!data.settings.blurAll);
}

function card(item) {
  const a = analyze(item.url);
  const canPreview = !!(a.embed || a.direct);
  const thumb = el('div', { class: 'thumb' + (item.sensitive ? ' sensitive' : '') });
  if (item.thumb) {
    const img = el('img', { src: item.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' });
    img.onerror = () => img.remove();
    thumb.append(img);
  }
  thumb.append(el('span', { class: 'ph', text: (domainOf(item.url)[0] || '?').toUpperCase() }));
  if (item.type !== 'page') thumb.append(el('span', { class: 'badge' }, svg(item.type === 'video' ? ICONS.play : ICONS.audio)));
  thumb.onclick = () => canPreview ? preview(item) : openUrl(item);
  thumb.title = canPreview ? 'Aperçu' : 'Ouvrir';

  const title = el('a', { class: 'title', href: item.url, text: item.title || item.url, rel: 'noopener noreferrer', target: '_blank',
    onclick: (e) => { e.preventDefault(); openUrl(item); } });
  const meta = el('div', { class: 'meta' },
    el('span', { text: a.provider && a.provider !== 'Fichier' ? a.provider : domainOf(item.url) }),
    ...(item.tags || []).slice(0, 3).map(t => el('span', { class: 'tag', text: '#' + t })));
  const more = el('button', { class: 'icon more', title: 'Options', 'aria-label': 'Options', onclick: () => menu(item) }, svg(ICONS.more));
  return el('article', { class: 'card' }, thumb, el('div', { class: 'body' }, title, meta), more);
}

// ---------- Filtres ----------
$('#q').oninput = (e) => { filter.q = e.target.value; render(); };
$('#sort').onchange = (e) => { filter.sort = e.target.value; render(); };
$$('#typeChips .chip').forEach(c => c.onclick = () => { filter.type = c.dataset.type; render(); });
$('#sensBtn').onclick = () => { showSensitive = !showSensitive; render(); toast(showSensitive ? 'Favoris sensibles affichés' : 'Favoris sensibles masqués'); };
$('#lockBtn').onclick = lock;

// ---------- Menu ----------
let menuItem = null;
function menu(item) {
  menuItem = item;
  const a = analyze(item.url);
  $('#menuTitle').textContent = item.title || item.url;
  $('#menuPreview').hidden = !(a.embed || a.direct || item.thumb);
  $('#menuShare').hidden = !navigator.share;
  $('#menuDlg').showModal();
}
$('#menuDlg').addEventListener('close', async () => {
  const item = menuItem, v = $('#menuDlg').returnValue; menuItem = null;
  if (!item) return;
  if (v === 'open') openUrl(item);
  else if (v === 'preview') preview(item);
  else if (v === 'copy') { await copy(item.url); }
  else if (v === 'share') navigator.share({ url: item.url, title: item.title }).catch(() => {});
  else if (v === 'edit') openEditor(item);
  else if (v === 'delete') {
    if (!confirm(`Supprimer « ${item.title || item.url} » ?`)) return;
    data.items = data.items.filter(i => i.id !== item.id);
    data.tombstones[item.id] = Date.now();
    await persist(); render(); toast('Supprimé');
  }
});
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Lien copié'); }
  catch { prompt('Copie le lien :', text); }
}

// ---------- Aperçu ----------
function preview(item) {
  const a = analyze(item.url);
  const p = $('#player'); p.replaceChildren(); p.className = 'player ' + item.type;
  if (a.direct === 'video') p.append(el('video', { src: item.url, controls: true, autoplay: true, playsinline: true, preload: 'metadata', poster: item.thumb || null }));
  else if (a.direct === 'audio') p.append(el('audio', { src: item.url, controls: true, autoplay: true }));
  else if (a.embed) p.append(el('iframe', { src: a.embed, allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', loading: 'eager' }));
  else if (item.thumb) p.append(el('img', { src: item.thumb, alt: '', referrerpolicy: 'no-referrer' }));
  $('#viewTitle').textContent = item.title || item.url;
  $('#viewDomain').textContent = domainOf(item.url);
  $('#viewOpen').onclick = () => { $('#viewDlg').close(); openUrl(item); };
  $('#viewDlg').showModal();
}
$('#viewClose').onclick = () => $('#viewDlg').close();
$('#viewDlg').addEventListener('close', () => $('#player').replaceChildren());
$('#viewDlg').addEventListener('click', (e) => { if (e.target.id === 'viewDlg') $('#viewDlg').close(); });

// ---------- Éditeur ----------
let editing = null, lastFetched = '';
function openEditor(item, prefill = null) {
  editing = item;
  const f = $('#editForm'); f.reset(); $('.error', f).textContent = '';
  $('#editTitle').textContent = item ? 'Modifier le favori' : 'Nouveau favori';
  const src = item || { url: '', title: '', type: 'page', thumb: '', tags: [], note: '', sensitive: false, ...(prefill || {}) };
  f.url.value = src.url; f.title.value = src.title || ''; f.type.value = src.type || 'page';
  f.thumb.value = src.thumb || ''; f.tags.value = (src.tags || []).join(', '); f.note.value = src.note || '';
  f.sensitive.checked = !!src.sensitive;
  lastFetched = item ? item.url : '';
  updateMini();
  $('#editDlg').showModal();
  if (!item && src.url) autoFill(true);
  else if (!src.url) f.url.focus();
}

function updateMini() {
  const f = $('#editForm'), box = $('#editPreview');
  box.replaceChildren();
  if (f.thumb.value) {
    const img = el('img', { src: f.thumb.value, alt: '', referrerpolicy: 'no-referrer' });
    img.onerror = () => img.remove();
    box.append(img);
  }
  box.hidden = !f.thumb.value;
}

async function autoFill(force = false) {
  const f = $('#editForm');
  const url = f.url.value.trim();
  if (!/^https?:\/\//i.test(url) || (!force && url === lastFetched)) return;
  lastFetched = url;
  const a = analyze(url);
  if (a.type) f.type.value = a.type;
  if (a.thumb && !f.thumb.value) { f.thumb.value = a.thumb; updateMini(); }
  $('#fetchBtn').disabled = true; $('#fetchBtn').textContent = 'Recherche…';
  try {
    const p = await fetchPreview(url, sync.metaConfig(data.settings.backup));
    if (p.title && !f.title.value) f.title.value = p.title;
    if (p.thumb && (!f.thumb.value || force)) { f.thumb.value = p.thumb; updateMini(); }
    if (p.type && p.type !== 'page') f.type.value = p.type;
  } finally { $('#fetchBtn').disabled = false; $('#fetchBtn').textContent = 'Récupérer l’aperçu'; }
}

$('#editForm').url.addEventListener('change', () => autoFill());
$('#editForm').url.addEventListener('paste', () => setTimeout(() => autoFill(), 0));
$('#editForm').thumb.addEventListener('change', updateMini);
$('#fetchBtn').onclick = () => autoFill(true);
$('#pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    const url = extractUrl(t) || t.trim();
    $('#editForm').url.value = url; autoFill(true);
  } catch { toast('Accès au presse-papiers refusé : colle avec un appui long.'); }
};

$('#editDlg').addEventListener('close', async () => {
  if ($('#editDlg').returnValue !== 'ok' || !data) return;
  const f = $('#editForm');
  const url = f.url.value.trim();
  const now = Date.now();
  const fields = {
    url, title: f.title.value.trim(), type: f.type.value, thumb: f.thumb.value.trim(),
    tags: [...new Set(f.tags.value.split(',').map(t => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))],
    note: f.note.value.trim(), sensitive: f.sensitive.checked, updatedAt: now,
  };
  if (editing) Object.assign(data.items.find(i => i.id === editing.id) || {}, fields);
  else {
    const dup = data.items.find(i => i.url === url);
    if (dup && !confirm('Ce lien est déjà dans tes favoris. L’ajouter quand même ?')) return;
    data.items.push({ id: uid(), createdAt: now, visits: 0, ...fields });
  }
  editing = null;
  await persist(); render(); toast('Enregistré');
});
$('#editForm').addEventListener('submit', (e) => {
  const f = e.target;
  if (e.submitter?.value === 'ok' && !/^https?:\/\/.+/i.test(f.url.value.trim())) { e.preventDefault(); $('.error', f).textContent = 'Lien invalide (doit commencer par http:// ou https://).'; }
});
$('#addBtn').onclick = () => openEditor(null);

// Coller une URL n'importe où dans l'app = ajout rapide
addEventListener('paste', (e) => {
  if (!data || document.querySelector('dialog[open]') || e.target.closest('input,textarea')) return;
  const url = extractUrl(e.clipboardData.getData('text'));
  if (url) { e.preventDefault(); openEditor(null, { url }); }
});

// ---------- Réglages ----------
const CODE_RE = /[A-Z0-9]{4}(-[A-Z0-9]{4}){3,7}(?=[/?#]|$)/i;
function showCode() {
  const m = $('#setForm').bUrl.value.match(CODE_RE);
  $('#bCodeBox').hidden = !m;
  $('#bCode').textContent = m ? m[0].toUpperCase() : '';
}
$('#setForm').bUrl.addEventListener('input', showCode);
$('#bCopy').onclick = () => copy($('#bCode').textContent);
$('#settingsBtn').onclick = () => {
  const f = $('#setForm'), s = data.settings, b = s.backup;
  f.autoLock.value = String(s.autoLock); f.lockOnHide.checked = s.lockOnHide; f.blurAll.checked = s.blurAll;
  f.bUrl.value = b.url; f.bHeader.value = b.header; f.bValue.value = b.value; f.bMeta.value = b.meta; f.bAuto.checked = b.auto;
  $('#bStatus').textContent = ''; $('#dataStatus').textContent = ''; showCode();
  $('#version').textContent = `${VERSION.startsWith('__') ? 'dev' : 'v' + VERSION} · ${data.items.length} favoris`;
  $('#setDlg').showModal();
};
function readBackupForm() {
  const f = $('#setForm');
  return { url: f.bUrl.value.trim(), header: f.bHeader.value.trim(), value: f.bValue.value, meta: f.bMeta.value.trim(), auto: f.bAuto.checked };
}
function applySettings() {
  const f = $('#setForm');
  data.settings = { ...data.settings, autoLock: +f.autoLock.value, lockOnHide: f.lockOnHide.checked, blurAll: f.blurAll.checked, backup: readBackupForm(), updatedAt: Date.now() };
}
$('#setDlg').addEventListener('close', async () => {
  if ($('#setDlg').returnValue !== 'ok' || !data) return;
  applySettings(); await persist(); render(); bumpActivity(); toast('Réglages enregistrés');
});
$('#bGen').onclick = () => {
  const base = 'https://sauvegarde.toolsmaker.workers.dev/v1/bookmarks/';
  const cur = $('#setForm').bUrl.value.trim().replace(/[A-Z0-9]{4}(-[A-Z0-9]{4}){3,7}$/i, '');
  $('#setForm').bUrl.value = (cur || base) + sync.generateCode();
  showCode();
  $('#bStatus').textContent = 'Nouveau code généré. Note-le : il te servira à restaurer sur un autre appareil.';
};
$('#bTest').onclick = async () => {
  const st = $('#bStatus'); st.textContent = 'Test…';
  try {
    const r = await sync.pull(readBackupForm());
    st.textContent = r ? `✓ Connexion OK. Sauvegarde trouvée (${new Date(r.updatedAt).toLocaleString('fr-FR')}).` : '✓ Connexion OK. Aucune sauvegarde pour l’instant.';
  } catch (ex) { st.textContent = '✗ ' + (ex instanceof TypeError ? 'Injoignable : vérifie l’adresse et que ce site est autorisé (' + location.origin + ')' : ex.message); }
};
$('#bPush').onclick = async () => {
  applySettings(); await persist({ syncSoon: false });
  const st = $('#bStatus'); st.textContent = 'Envoi…';
  try { await sync.push(data.settings.backup, vault, { force: true }); st.textContent = '✓ Sauvegardé (' + new Date().toLocaleTimeString('fr-FR') + ')'; syncBar(''); }
  catch (ex) { st.textContent = '✗ ' + (ex instanceof TypeError ? 'Injoignable (réseau ou CORS)' : ex.message); }
};
$('#bPull').onclick = async () => {
  applySettings(); await persist({ syncSoon: false });
  $('#bStatus').textContent = 'Synchronisation…';
  const ok = await syncNow();
  $('#bStatus').textContent = ok ? '✓ Synchronisé' : '✗ ' + $('#syncBar').textContent.replace('⚠ ', '');
};

// Export / import
$('#exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(vault)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `safe-bookmarks-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const st = $('#dataStatus');
  try {
    const other = JSON.parse(await file.text());
    if (other.app !== 'coffre-liens') throw new Error('Fichier non reconnu');
    let od;
    try { od = await decryptJson(dek, other.data); }
    catch {
      const pw = await askPassword('Importer', 'Ce fichier a un autre mot de passe. Entre-le :');
      if (!pw) return;
      od = (await unlockVault(other, pw)).data;
    }
    const before = data.items.length;
    data = merge(data, normalize(od));
    await persist(); render();
    st.textContent = `✓ ${data.items.length - before} favoris ajoutés.`;
  } catch (ex) { st.textContent = '✗ ' + (ex.message === 'BAD_PASSWORD' ? 'Mot de passe incorrect' : ex.message); }
};
// Import des favoris exportés depuis un navigateur (format Netscape HTML)
$('#importHtmlBtn').onclick = () => $('#importHtml').click();
$('#importHtml').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
  const known = new Set(data.items.map(i => i.url));
  let n = 0; const now = Date.now();
  for (const a of doc.querySelectorAll('a[href]')) {
    const url = a.getAttribute('href');
    if (!/^https?:/i.test(url) || known.has(url)) continue;
    known.add(url);
    const folder = a.closest('dl')?.previousElementSibling?.textContent?.trim();
    const an = analyze(url);
    const added = +a.getAttribute('add_date') * 1000 || now;
    data.items.push({ id: uid(), url, title: a.textContent.trim(), type: an.type, thumb: an.thumb || '', tags: folder ? [folder.toLowerCase()] : [], note: '', sensitive: false, createdAt: added, updatedAt: now, visits: 0 });
    n++;
  }
  await persist(); render();
  $('#dataStatus').textContent = `✓ ${n} favoris importés.`;
};
$('#refreshThumbs').onclick = async () => {
  const st = $('#dataStatus');
  const todo = data.items.filter(i => !i.thumb || !i.title);
  let done = 0;
  for (const it of todo) {
    st.textContent = `Aperçus : ${done}/${todo.length}…`;
    const p = await fetchPreview(it.url, sync.metaConfig(readBackupForm()));
    if ((p.thumb && !it.thumb) || (p.title && !it.title)) {
      it.thumb = it.thumb || p.thumb; it.title = it.title || p.title; it.updatedAt = Date.now();
    }
    done++;
  }
  await persist(); render();
  st.textContent = `✓ ${todo.length} favoris vérifiés.` + (!readBackupForm().meta ? ' Pour les pages ordinaires, renseigne l’adresse d’aperçu dans les options avancées.' : '');
};
$('#pwBtn').onclick = async () => {
  const r = await askPassword('Changer le mot de passe', 'Les autres appareils devront utiliser le nouveau mot de passe.', true);
  if (!r) return;
  try {
    vault = await rewrapVault(vault, r.old, r.next);
    saveLocalBlob(vault);
    if (sync.isConfigured(data.settings.backup)) await sync.push(data.settings.backup, vault, { force: true });
    $('#dataStatus').textContent = '✓ Mot de passe changé.';
  } catch (ex) { $('#dataStatus').textContent = '✗ ' + (ex.message === 'BAD_PASSWORD' ? 'Ancien mot de passe incorrect' : ex.message); }
};
$('#wipeBtn').onclick = () => {
  if (!confirm('Effacer le coffre de CET appareil ? La sauvegarde cloud n’est pas touchée.')) return;
  localStorage.removeItem(LS_KEY); lock();
};

function askPassword(title, msg, change = false) {
  const d = $('#pwDlg'), f = $('#pwForm');
  f.reset(); $('.error', f).textContent = '';
  $('#pwTitle').textContent = title; $('#pwMsg').textContent = msg;
  f.a.placeholder = change ? 'Mot de passe actuel' : 'Mot de passe';
  f.b.hidden = f.c.hidden = !change;
  d.showModal(); f.a.focus();
  return new Promise((res) => {
    f.onsubmit = (e) => {
      if (e.submitter?.value !== 'ok') return;
      if (change) {
        if (f.b.value.length < 6) { e.preventDefault(); $('.error', f).textContent = 'Au moins 6 caractères.'; return; }
        if (f.b.value !== f.c.value) { e.preventDefault(); $('.error', f).textContent = 'Les mots de passe ne correspondent pas.'; return; }
      }
    };
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return res(null);
      res(change ? { old: f.a.value, next: f.b.value } : f.a.value);
      f.reset();
    }, { once: true });
  });
}

// ---------- Partage entrant (Web Share Target) ----------
function readShare() {
  const p = new URLSearchParams(location.search);
  if (!p.has('url') && !p.has('text') && !p.has('title')) return;
  const url = extractUrl(p.get('url'), p.get('text'), p.get('title'));
  let title = p.get('title') || '';
  if (url && title.includes(url)) title = title.replace(url, '').trim();
  if (url) pendingShare = { url, title };
  // On efface les paramètres de l'URL pour ne rien laisser dans l'historique
  history.replaceState(null, '', location.pathname);
}

// ---------- Démarrage ----------
readShare();
showLock();
if (pendingShare && loadLocal()) $('#unlockForm .muted').textContent = 'Déverrouille pour ajouter le lien partagé';
// Mises à jour automatiques : vérification à chaque ouverture / retour au premier plan, rechargement dès qu'une nouvelle version prend la main.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return; // première installation : rien à recharger
    reloaded = true;
    if (data) toast('Mise à jour installée', 1500); // le coffre se reverrouille au rechargement
    setTimeout(() => location.reload(), data ? 600 : 0);
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
