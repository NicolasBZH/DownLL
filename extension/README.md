# Extension DownLL (Chrome / Brave / Edge)

Un bouton **« Télécharger cette page »** dans ton navigateur : il lit l'URL de
l'onglet **et tes cookies de session** (y compris les cookies `HttpOnly`, que le
site cache aux scripts) et les envoie à ton serveur DownLL. yt-dlp les réutilise
→ tu télécharges les vidéos **à restriction d'âge / derrière login** depuis ta
session déjà connectée.

## Côté serveur (une fois)

Définis un jeton partagé **en plus** du mot de passe, et redémarre DownLL :

```bash
# Docker : ajoute la variable (ex. dans un .env ou -e)
DOWNLL_TOKEN=un-long-jeton-secret
AUTH_PASSWORD=ton-mot-de-passe
```

(Le jeton permet à l'extension d'appeler `/api/download` sans passer par l'écran
de login. Garde-le secret.)

## Installer l'extension (mode développeur, ~30 s)

1. Ouvre `chrome://extensions` (ou `brave://extensions`).
2. Active **« Mode développeur »** (en haut à droite).
3. **« Charger l'extension non empaquetée »** → choisis ce dossier `extension/`.
4. Épingle l'icône DownLL dans la barre.

## Utiliser

1. Clique l'icône → **Réglages ▾** : mets l'**URL de ton serveur** DownLL
   (`https://ton-domaine`) et ton **jeton** (`DOWNLL_TOKEN`), puis **Enregistrer**
   (accepte la demande de permission).
2. Va sur une vidéo (connecté à ton compte si elle est restreinte).
3. Clique l'icône → **« Télécharger cette page »**. Le job démarre sur DownLL
   (suis-le dans l'onglet Téléchargeur).

## Notes

- Par défaut l'extension joint les cookies **du site courant + youtube.com +
  google.com** (ce qu'il faut pour YouTube âge/login).
- Rien n'est envoyé ailleurs que vers **ton** serveur DownLL.
- Sur un serveur exposé : sers DownLL en **HTTPS** (le jeton transite dans l'en-tête).
