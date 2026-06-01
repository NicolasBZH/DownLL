# DownLL

Site de téléchargement vidéo (**MP4**) basé sur [yt-dlp](https://github.com/yt-dlp/yt-dlp).

- ⚡ **Sans base de données** — l'état des téléchargements vit en mémoire, les
  fichiers transitent par un dossier temporaire et sont supprimés après envoi.
- 📲 **PWA installable en un clic** sur mobile (« Ajouter à l'écran d'accueil »).
- 🌐 **Tous les sites yt-dlp** (YouTube, Vimeo, X/Twitter, TikTok, SoundCloud…).
- 🎚️ Choix de la **qualité** (Meilleure / 1080p / 720p / 480p), fusion via ffmpeg.
- 🔒 Backend Node.js/Express ; yt-dlp est appelé en sous-processus (pas de shell,
  pas d'injection), avec limitation de débit et de concurrence.

---

## Architecture

```
Navigateur (PWA)  ──►  Express (server.js)  ──►  yt-dlp + ffmpeg  ──►  fichier MP4
        ▲                      │
        └──── progression SSE ─┘
```

| Endpoint                 | Rôle                                            |
| ------------------------ | ----------------------------------------------- |
| `POST /api/info`         | Métadonnées (titre, miniature, durée, qualités) |
| `POST /api/download`     | Démarre un job, renvoie un `jobId`              |
| `GET  /api/progress/:id` | Progression en temps réel (Server-Sent Events)  |
| `GET  /api/file/:id`     | Sert le MP4 puis supprime le fichier            |

L'app écoute en HTTP sur `127.0.0.1:3000`. **Le HTTPS, le domaine et le
certificat sont gérés par ton panel** (reverse-proxy) — c'est ce HTTPS qui rend
l'installation PWA possible sur mobile.

---

## Déploiement sur serveur Debian / Ubuntu (sans Docker)

Prérequis : un accès root/sudo. Node, ffmpeg et yt-dlp sont installés par le
script.

```bash
# 1. Récupérer le projet (emplacement conseillé : /opt/downll)
sudo git clone <ton-repo> /opt/downll
cd /opt/downll

# 2. Installer (deps système + Node + yt-dlp + service systemd)
sudo bash deploy/install.sh
```

Le service est alors actif et écoute sur `http://127.0.0.1:3000` :

```bash
systemctl status downll      # état
journalctl -u downll -f      # logs en direct
```

### 3. Brancher ton panel (reverse-proxy + HTTPS)

Crée le domaine dans ton panel et fais pointer son reverse-proxy vers
`http://127.0.0.1:3000`.

**Point critique : désactive le buffering du proxy**, sinon la barre de
progression (SSE) et le téléchargement du fichier restent bloqués jusqu'à la
fin.

- Reverse-proxy **Go** maison (ex. nlaunchpanel) : mets `FlushInterval = -1` sur
  ton `httputil.ReverseProxy` et `WriteTimeout = 0` sur le `http.Server`.
  Référence complète : [`deploy/reverse-proxy.go.example`](deploy/reverse-proxy.go.example).
- **nginx** : `proxy_buffering off;` + timeouts longs.
  Voir [`deploy/nginx-downll.conf.example`](deploy/nginx-downll.conf.example).

Ouvre ensuite `https://ton-domaine` sur ton téléphone → **« Ajouter à l'écran
d'accueil »** (Android/Chrome : bouton « Installer » ; iOS/Safari : Partager →
Sur l'écran d'accueil).

### Mettre à jour plus tard

```bash
cd /opt/downll
sudo bash deploy/update.sh   # git pull + npm install + maj yt-dlp + restart
```

---

## Tester rapidement avec Docker (Windows / Mac / Linux)

Pour **tester** l'app sans rien installer (yt-dlp et ffmpeg sont fournis par
l'image), il y a un chemin Docker. Ce n'est **pas** le mode de production
(prod = systemd ci-dessus), c'est juste pour essayer en local.

Sur **Windows** : double-clic sur **`test-docker.cmd`** (ou en ligne de commande) :

```powershell
.\scripts\docker-test.ps1            # build + démarre + ouvre le navigateur
.\scripts\docker-test.ps1 -Port 8080 # si le port 3000 est déjà pris
.\scripts\docker-test.ps1 -Logs      # logs en direct
.\scripts\docker-test.ps1 -Down       # arrêt + suppression du conteneur
```

Sur **Mac/Linux** (ou sans le script) :

```bash
docker compose up -d --build   # puis http://localhost:3000
docker compose logs -f
docker compose down
```

> Sur `localhost`, Chrome considère le contexte comme sécurisé : la PWA est donc
> testable et installable même sans HTTPS. (Depuis un téléphone, il faut le
> déploiement serveur derrière ton panel.)

---

## Développement local (Windows / Mac / Linux)

Prérequis : **Node ≥ 18**, **yt-dlp** et **ffmpeg** accessibles dans le `PATH`.

```powershell
# Windows (winget)
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg

npm install      # installe les deps + génère les icônes
npm start        # http://localhost:3000
```

Sur Mac/Linux : `brew install yt-dlp ffmpeg` (ou `pipx install yt-dlp`), puis
`npm install && npm start`.

> En `http://localhost` la PWA est testable, mais l'installation depuis un
> téléphone exige HTTPS (donc le déploiement serveur ci-dessus, derrière ton
> panel).

---

## Configuration (variables d'environnement)

Définies dans le service systemd ([`deploy/downll.service`](deploy/downll.service)).

| Variable          | Défaut         | Description                                  |
| ----------------- | -------------- | -------------------------------------------- |
| `PORT`            | `3000`         | Port d'écoute (local)                        |
| `YTDLP_PATH`      | `yt-dlp`       | Chemin du binaire yt-dlp                     |
| `TMP_DIR`         | `<tmp>/downll` | Dossier des fichiers temporaires             |
| `FILE_TTL_MS`     | `3600000`      | Durée de vie d'un fichier prêt (1 h)         |
| `MAX_CONCURRENT`  | `3`            | Téléchargements simultanés max               |
| `MAX_DURATION_S`  | `0`            | Refuse les vidéos plus longues (secondes)    |
| `MAX_FILESIZE`    | *(vide)*       | Ex. `4G` — taille max par téléchargement     |
| `INFO_TIMEOUT_MS` | `45000`        | Délai max d'analyse d'une URL                |
| `TRUST_PROXY`     | `1`            | Confiance au reverse-proxy du panel          |

---

## Notes légales

Cet outil est destiné au téléchargement de contenus pour lesquels tu disposes
des droits nécessaires. Respecte le droit d'auteur et les conditions
d'utilisation des plateformes.
