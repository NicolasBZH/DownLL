# Proxy SOCKS5 Tor minimal pour DownLL (sidecar optionnel).
# Lancé uniquement via l'override docker-compose.tor.yml.
FROM alpine:3.20

RUN apk add --no-cache tor \
  && mkdir -p /var/lib/tor \
  && chown -R tor:tor /var/lib/tor

# Le torrc est généré au démarrage (port de contrôle activé si un mot de passe
# est fourni via TOR_CONTROL_PASSWORD -> bouton "Nouvelle IP").
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# tor tourne sans privilèges.
USER tor
EXPOSE 9050 9051

# Le démarrage de Tor (bootstrap des circuits) prend quelques secondes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD nc -z 127.0.0.1 9050 || exit 1

CMD ["/usr/local/bin/start.sh"]
