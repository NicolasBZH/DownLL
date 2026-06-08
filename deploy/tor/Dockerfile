# Proxy SOCKS5 Tor minimal pour DownLL (sidecar optionnel).
# Lancé uniquement via l'override docker-compose.tor.yml.
FROM alpine:3.20

RUN apk add --no-cache tor \
  && printf 'SocksPort 0.0.0.0:9050\nDataDirectory /var/lib/tor\nLog notice stderr\n' \
       > /etc/tor/torrc \
  && chown -R tor:tor /var/lib/tor

# tor tourne sans privilèges.
USER tor
EXPOSE 9050

# Le démarrage de Tor (bootstrap des circuits) prend quelques secondes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD nc -z 127.0.0.1 9050 || exit 1

CMD ["tor", "-f", "/etc/tor/torrc"]
