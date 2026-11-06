# Signets

PWA statique de favoris privés : pages, vidéos (aperçu + lecteur intégré), audio.

- **Verrou** par mot de passe, données chiffrées AES-GCM 256 (clé dérivée PBKDF2, 600 000 itérations) dans le navigateur.
- **Sauvegarde** chiffrée vers un worker Cloudflare KV (`worker/worker.js`), fusion automatique entre appareils.
- **Partage** depuis le navigateur du téléphone (Android, PWA installée) via Web Share Target.
- Aucun traceur, `no-referrer`, double Échap = verrouillage immédiat.

## Déploiement
Settings → Pages → Source : *GitHub Actions*. Le site est servi sur `https://<user>.github.io/bookmarks/`.

## Worker
`worker/worker.js` + liaison KV `BACKUP`, secrets `TOKEN` et `ALLOWED_ORIGIN=https://toolsmaker2099.github.io`.
Dans l'app : URL `…/backup`, en-tête `Authorization`, valeur `Bearer <TOKEN>`, URL d'aperçu `…/meta?url={url}`.
