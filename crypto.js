// Chiffrement côté client : rien ne sort de l'appareil en clair.
// Mot de passe -> PBKDF2-SHA256 -> clé d'enveloppe (KEK) -> déchiffre la clé de données (DEK, AES-GCM 256).
const enc = new TextEncoder();
const dec = new TextDecoder();
export const KDF_ITER = 600000;

export const b64 = {
  enc(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function deriveKek(password, salt, iter = KDF_ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptBytes(key, bytes) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: b64.enc(iv), ct: b64.enc(ct) };
}
export async function decryptBytes(key, box) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(box.iv) }, key, b64.dec(box.ct)));
}
export async function encryptJson(key, obj) { return encryptBytes(key, enc.encode(JSON.stringify(obj))); }
export async function decryptJson(key, box) { return JSON.parse(dec.decode(await decryptBytes(key, box))); }

const importDek = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

// Crée un nouveau coffre vide protégé par `password`.
export async function createVault(password, data) {
  const salt = rand(16);
  const kek = await deriveKek(password, salt);
  const raw = rand(32);
  const dek = await importDek(raw);
  const wk = await encryptBytes(kek, raw);
  raw.fill(0);
  const vault = {
    app: 'coffre-liens', v: 1,
    kdf: { alg: 'PBKDF2-SHA256', iter: KDF_ITER, salt: b64.enc(salt) },
    wk, data: await encryptJson(dek, data), updatedAt: Date.now(),
  };
  return { vault, dek };
}

// Ouvre un coffre. Lève une erreur si le mot de passe est faux.
export async function unlockVault(vault, password) {
  const kek = await deriveKek(password, b64.dec(vault.kdf.salt), vault.kdf.iter);
  let raw;
  try { raw = await decryptBytes(kek, vault.wk); } catch { throw new Error('BAD_PASSWORD'); }
  const dek = await importDek(raw);
  const fp = await fingerprint(raw);
  raw.fill(0);
  const data = await decryptJson(dek, vault.data);
  return { dek, data, fp };
}

// Empreinte de la clé de données (pour savoir si deux coffres partagent la même clé).
async function fingerprint(raw) {
  return b64.enc(await crypto.subtle.digest('SHA-256', raw)).slice(0, 16);
}

export async function sealVault(vault, dek, data) {
  return { ...vault, data: await encryptJson(dek, data), updatedAt: Date.now() };
}

// Change le mot de passe : seule l'enveloppe de la clé change.
export async function rewrapVault(vault, oldPassword, newPassword) {
  const kek = await deriveKek(oldPassword, b64.dec(vault.kdf.salt), vault.kdf.iter);
  let raw;
  try { raw = await decryptBytes(kek, vault.wk); } catch { throw new Error('BAD_PASSWORD'); }
  const salt = rand(16);
  const kek2 = await deriveKek(newPassword, salt);
  const wk = await encryptBytes(kek2, raw);
  raw.fill(0);
  return { ...vault, kdf: { alg: 'PBKDF2-SHA256', iter: KDF_ITER, salt: b64.enc(salt) }, wk, updatedAt: Date.now() };
}

