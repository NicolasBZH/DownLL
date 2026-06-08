#!/usr/bin/env bash
#
# Installation de DownLL sur Debian / Ubuntu (sans Docker).
# À lancer depuis le dossier du projet :  sudo bash deploy/install.sh
#
# Le HTTPS, le domaine et le reverse-proxy sont gérés par ton panel :
# il suffit de proxifier ton domaine vers http://127.0.0.1:3000
# (voir deploy/nginx-downll.conf.example).

set -euo pipefail

SERVICE_USER="downll"
PORT="${PORT:-3000}"

# Racine du projet = dossier parent de ce script.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Ce script doit être lancé en root (sudo)." >&2
  exit 1
fi

echo "==> 1/7  Dépendances système (ffmpeg, python3, pip)…"
apt-get update
apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl

echo "==> 2/7  Node.js >= 18…"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" -ge 18 ]] && need_node=0
fi
if [[ "$need_node" -eq 1 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "    node : $NODE_BIN ($(node --version))"

echo "==> 3/7  yt-dlp (binaire autonome, canal nightly)…"
# Canal nightly : les correctifs d'extraction (YouTube & co, « HTTP 410 Gone »)
# y arrivent des semaines avant le canal stable.
curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
echo "    yt-dlp : $(/usr/local/bin/yt-dlp --version)"

# curl_cffi : impersonation TLS « navigateur » (option --impersonate), requise
# par certains sites anti-bot (ex. PornHub, sinon « HTTP Error 410: Gone »).
echo "    curl_cffi (impersonation)…"
pip3 install --break-system-packages --no-cache-dir curl_cffi 2>/dev/null \
  || pip3 install --no-cache-dir curl_cffi || true

echo "==> 4/7  Utilisateur de service ($SERVICE_USER)…"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "==> 5/7  Dépendances Node + icônes…"
cd "$APP_DIR"
npm install --omit=dev
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

echo "==> 6/7  Service systemd…"
sed \
  -e "s#/opt/downll#${APP_DIR}#g" \
  -e "s#ExecStart=/usr/bin/node#ExecStart=${NODE_BIN}#" \
  -e "s#^Environment=PORT=3000#Environment=PORT=${PORT}#" \
  deploy/downll.service > /etc/systemd/system/downll.service

systemctl daemon-reload
systemctl enable --now downll

echo "==> 7/7  Timer de mise à jour quotidienne de yt-dlp…"
cp deploy/downll-ytdlp-update.service /etc/systemd/system/downll-ytdlp-update.service
cp deploy/downll-ytdlp-update.timer   /etc/systemd/system/downll-ytdlp-update.timer
systemctl daemon-reload
systemctl enable --now downll-ytdlp-update.timer

echo
echo "✅ Terminé. DownLL écoute sur http://127.0.0.1:${PORT}"
echo "   État   : systemctl status downll"
echo "   Logs   : journalctl -u downll -f"
echo
echo "👉 Dans ton panel : proxifie ton domaine (HTTPS) vers http://127.0.0.1:${PORT}"
echo "   (pense à désactiver le buffering pour la barre de progression — cf. nginx-downll.conf.example)"
