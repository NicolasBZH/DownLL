#!/usr/bin/env bash
#
# Met à jour DownLL : code (git), dépendances, yt-dlp, puis redémarre le service.
# À lancer en root depuis le dossier du projet :  sudo bash deploy/update.sh

set -euo pipefail

SERVICE_USER="downll"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Lance ce script en root (sudo)." >&2
  exit 1
fi

cd "$APP_DIR"

echo "==> Mise à jour de yt-dlp…"
/usr/local/bin/yt-dlp -U 2>/dev/null || \
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

if [[ -d .git ]]; then
  echo "==> Récupération du code (git pull)…"
  sudo -u "$SERVICE_USER" git pull --ff-only || git pull --ff-only
fi

echo "==> Dépendances Node…"
npm install --omit=dev
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

echo "==> Redémarrage du service…"
systemctl restart downll
systemctl status downll --no-pager | head -n 5
echo "✅ Mise à jour terminée."
