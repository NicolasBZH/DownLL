#!/bin/sh
# Génère le torrc puis lance Tor. Si TOR_CONTROL_PASSWORD est défini, on active
# le port de contrôle (9051) protégé par mot de passe -> permet à DownLL
# d'envoyer SIGNAL NEWNYM (bouton "Nouvelle IP").
set -e

RC=/tmp/torrc
{
  echo "SocksPort 0.0.0.0:9050"
  echo "DataDirectory /var/lib/tor"
  echo "Log notice stderr"
} > "$RC"

if [ -n "$TOR_CONTROL_PASSWORD" ]; then
  HASH=$(tor --hash-password "$TOR_CONTROL_PASSWORD" 2>/dev/null | tail -n 1)
  if [ -n "$HASH" ]; then
    echo "ControlPort 0.0.0.0:9051" >> "$RC"
    echo "HashedControlPassword $HASH" >> "$RC"
  fi
fi

exec tor -f "$RC"
