# Image Docker — destinée surtout aux TESTS locaux (Windows/Mac/Linux).
# Elle embarque yt-dlp + ffmpeg : aucun outil à installer sur l'hôte.
# (En production, DownLL tourne en bare-metal via systemd — cf. deploy/.)

FROM node:20-bookworm-slim

# yt-dlp (binaire autonome) + ffmpeg (fusion) + python3 (requis par yt-dlp)
# On installe le canal NIGHTLY : les correctifs d'extraction (YouTube & co,
# erreurs « HTTP 410 Gone ») y arrivent des semaines avant le canal stable.
# Ce binaire n'est qu'un socle : l'entrypoint le rafraîchit au démarrage
# (BuildKit met les téléchargements en cache -> impossible de s'y fier seul).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && pip3 install --break-system-packages --no-cache-dir curl_cffi \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
# curl_cffi = impersonation TLS « navigateur » pour yt-dlp (--impersonate).
# Indispensable pour des sites qui bloquent les clients non-navigateur
# (ex. PornHub -> sinon « HTTP Error 410: Gone »).

WORKDIR /app

# Dépendances (sans postinstall : gen-icons est lancé après la copie des sources).
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Chromium pour le navigateur intégré (Playwright). Chemin fixe pour que le
# binaire soit retrouvé au runtime (HOME diffère entre build et exécution).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Chromium + Xvfb (écran virtuel) : permet le mode "headful" (BROWSER_HEADFUL=1),
# beaucoup moins détectable que headless par les sites anti-bot agressifs.
# PulseAudio : capture le son de Chromium pour le mode "HD + son" (ffmpeg -> MSE).
RUN npx playwright install --with-deps chromium \
  && apt-get update \
  && apt-get install -y --no-install-recommends xvfb pulseaudio pulseaudio-utils \
  && usermod -aG pulse-access root \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN node scripts/gen-icons.js \
  && chmod a+rx docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    TMP_DIR=/tmp/downll \
    HOME=/tmp \
    YTDLP_AUTOUPDATE=1 \
    IMPERSONATE=chrome \
    BROWSER_HEADFUL=1

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# L'entrypoint met yt-dlp à jour (nightly) avant de lancer le serveur.
# Désactivable avec YTDLP_AUTOUPDATE=0.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
