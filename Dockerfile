# Image Docker — destinée surtout aux TESTS locaux (Windows/Mac/Linux).
# Elle embarque yt-dlp + ffmpeg : aucun outil à installer sur l'hôte.
# (En production, DownLL tourne en bare-metal via systemd — cf. deploy/.)

FROM node:20-bookworm-slim

# yt-dlp (binaire autonome) + ffmpeg (fusion) + python3 (requis par yt-dlp)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances (sans postinstall : gen-icons est lancé après la copie des sources).
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .
RUN node scripts/gen-icons.js

ENV NODE_ENV=production \
    PORT=3000 \
    TMP_DIR=/tmp/downll \
    HOME=/tmp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
