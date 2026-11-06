# Signets

PWA statique de favoris privés : pages, vidéos (aperçu + lecteur intégré), audio.

- **Verrou** par mot de passe, données chiffrées AES-GCM 256 (clé dérivée PBKDF2, 600 000 itérations) dans le navigateur.
- **Sauvegarde** chiffrée vers un worker Cloudflare KV (`worker/worker.js`), fusion automatique entre appareils.
- **Partage** depuis le navigateur du téléphone (Android, PWA installée) via Web Share Target.
- Aucun traceur, `no-referrer`, double Échap = verrouillage immédiat.

## Déploiement
Settings → Pages → Source : *GitHub Actions*. Le site est servi sur `https://<user>.github.io/bookmarks/`.

## Sauvegarde (worker « sauvegarde » toolsmaker)
Dans le worker, ajouter une ligne dans `APPS` :

    bookmarks: { origins: ['https://toolsmaker2099.github.io'], maxKo: 1024, keepDays: 730 },

Dans l'app : Réglages → URL `https://sauvegarde.toolsmaker.workers.dev/v1/bookmarks/XXXX-XXXX-XXXX-XXXX`
(bouton « Générer un code »). Le code est le seul secret d'accès, et le contenu est de toute façon chiffré
avec le mot de passe du coffre. Pas de route d'aperçu de pages dans ce worker : seules les vidéos des
plateformes connues ont une miniature automatique (l'URL d'aperçu reste optionnelle).
