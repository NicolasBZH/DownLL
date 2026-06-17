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

# Mode navigateur "headful" (anti-détection renforcée) : on lance un écran
# virtuel Xvfb et on pointe DISPLAY dessus. Activé avec BROWSER_HEADFUL=1.
if [ "${BROWSER_HEADFUL:-0}" = "1" ] && command -v Xvfb >/dev/null 2>&1; then
  echo "→ Navigateur en mode headful (Xvfb :99)"
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
  i=0
  while [ $i -lt 10 ] && [ ! -e /tmp/.X11-unix/X99 ]; do
    i=$((i + 1))
    sleep 0.3
  done

  # --- Mode HD (vidéo + SON) : PulseAudio + écran dédié :100 (720p) ---
  if command -v pulseaudio >/dev/null 2>&1; then
    echo "→ Mode HD : PulseAudio + écran :100"
    grep -q 'sink_name=hd' /etc/pulse/system.pa 2>/dev/null \
      || echo "load-module module-null-sink sink_name=hd" >> /etc/pulse/system.pa
    grep -q 'set-default-sink hd' /etc/pulse/system.pa 2>/dev/null \
      || echo "set-default-sink hd" >> /etc/pulse/system.pa
    pulseaudio --system --daemonize=yes --exit-idle-time=-1 --log-target=file:/tmp/pulse.log 2>/dev/null || true
    export PULSE_SERVER=unix:/run/pulse/native
    Xvfb :100 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
  fi
fi

exec "$@"
