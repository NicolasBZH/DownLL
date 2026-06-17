'use strict';

/**
 * Petit client du port de contrôle de Tor : envoie SIGNAL NEWNYM pour forcer
 * de nouveaux circuits (donc une nouvelle IP de sortie). Utilisé par le
 * navigateur intégré (Chromium ne gère pas l'isolation par auth SOCKS).
 */

const net = require('net');

/**
 * @param {{host:string, port:number, password:string, timeoutMs?:number}} opts
 * @returns {Promise<void>}
 */
function newIdentity({ host, port, password, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let step = 0; // 0 = attend la réponse AUTHENTICATE, 1 = attend NEWNYM
    let buf = '';
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    sock.on('connect', () => {
      sock.write(`AUTHENTICATE "${String(password || '').replace(/(["\\])/g, '\\$1')}"\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (step === 0) {
        if (/^250/.test(line)) {
          step = 1;
          sock.write('SIGNAL NEWNYM\r\n');
        } else {
          finish(new Error('authentification refusée'));
        }
      } else if (step === 1) {
        if (/^250/.test(line)) {
          try {
            sock.write('QUIT\r\n');
          } catch {
            /* ignore */
          }
          finish();
        } else {
          finish(new Error('NEWNYM refusé'));
        }
      }
    });
    sock.on('error', (e) => finish(e));
  });
}

module.exports = { newIdentity };
