#!/bin/sh
# Entrypoint du conteneur DownLL.
# Avant de lancer le serveur, on rafraîchit yt-dlp sur le canal nightly :
# c'est là que les correctifs d'extraction (YouTube & co, « HTTP 410 Gone »)
# arrivent en premier. Best-effort : si le réseau est indisponible, on garde
# le binaire embarqué dans l'image et on démarre quand même.
#
# Désactiver avec  YTDLP_AUTOUPDATE=0.

if [ "${YTDLP_AUTOUPDATE:-1}" != "0" ]; then
  echo "→ Mise à jour de yt-dlp (nightly)…"
  yt-dlp --update-to nightly 2>&1 || echo "  (mise à jour ignorée — réseau indisponible ?)"
  yt-dlp --version 2>/dev/null | sed 's/^/  yt-dlp /'
fi

exec "$@"
