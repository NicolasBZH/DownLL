'use strict';

/**
 * Navigateur distant intégré (Phase 2).
 *
 * Un vrai Chromium (Playwright) tourne côté serveur. On streame son écran au
 * client (frames JPEG via le screencast CDP) sur un WebSocket, et on rejoue ses
 * entrées : souris, CLAVIER (avec IME mobile côté client) et TACTILE NATIF
 * (CDP Input.dispatchTouchEvent -> pincer/défiler marchent comme sur un vrai
 * téléphone). Les nouveaux onglets/popups sont suivis automatiquement.
 *
 * Le bouton « Télécharger » lit l'URL ET les cookies de l'onglet courant, puis
 * les passe à yt-dlp -> les sessions (login, age-gate) sont reprises.
 * Tor optionnel : contexte Chromium lancé via --proxy-server vers le sidecar.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const torControl = require('./tor-control');

let playwright = null;
try {
  playwright = require('playwright');
} catch {
  playwright = null;
}

const MAX_SESSIONS = parseInt(process.env.MAX_BROWSER_SESSIONS || '2', 10);
const IDLE_MS = parseInt(process.env.BROWSER_IDLE_MS || '300000', 10); // 5 min
const NAV_TIMEOUT = parseInt(process.env.BROWSER_NAV_TIMEOUT_MS || '30000', 10);

// Port de contrôle Tor (pour "Nouvelle IP" via SIGNAL NEWNYM). Ex "tor:9051".
const TOR_CONTROL = process.env.TOR_CONTROL || '';
const TOR_CONTROL_PASSWORD = process.env.TOR_CONTROL_PASSWORD || '';
const TOR_CTL_HOST = TOR_CONTROL.split(':')[0] || '';
const TOR_CTL_PORT = parseInt(TOR_CONTROL.split(':')[1] || '9051', 10);

// Chaque niveau pilote la RÉSOLUTION de rendu (petit côté visé, px), la
// compression JPEG et la cadence -> vrai compromis netteté / fluidité.
const QUALITY = {
  low: { minSide: 640, quality: 50, everyNth: 2 }, // Fluide
  auto: { minSide: 880, quality: 70, everyNth: 1 }, // équilibré (défaut)
  high: { minSide: 1080, quality: 88, everyNth: 1 }, // Net (1080p)
};
const MAX_DIM = 2560; // borne haute d'une frame (px)

// User-Agent réaliste (sans "HeadlessChrome", qui trahit l'automatisation).
const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Anti-détection : exécuté dans chaque page AVANT son code, masque les signaux
// d'automatisation les plus courants (webdriver, plugins, langues, WebGL...).
function stealthScript() {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr'] });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  } catch (e) {}
  try {
    window.chrome = window.chrome || { runtime: {} };
  } catch (e) {}
  try {
    const q = navigator.permissions && navigator.permissions.query;
    if (q) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : q(p);
    }
  } catch (e) {}
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return gp.call(this, p);
    };
  } catch (e) {}
}

/** Convertit PROXY en option proxy Playwright (Chromium = socks5 sans auth). */
function torProxyFor(proxy) {
  return proxy ? { server: proxy.replace(/^socks5h/i, 'socks5').replace(/\/\/[^@/]*@/, '//') } : null;
}

/** Cookies Playwright -> fichier Netscape cookies.txt pour yt-dlp. */
function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', ''];
  for (const c of cookies) {
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = Math.floor(c.expires && c.expires > 0 ? c.expires : 0);
    lines.push(
      [c.domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join(
        '\t'
      )
    );
  }
  return lines.join('\n') + '\n';
}

function setup({ isAuthed, createDownloadJob, proxy, tmpDir }) {
  if (!playwright) {
    console.log('Navigateur intégré désactivé (playwright non installé).');
    return { enabled: false };
  }
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  const controlAvailable = !!proxy && !!TOR_CONTROL && !!TOR_CONTROL_PASSWORD;

  let browser = null;
  let launching = null;
  const sessions = new Set();

  async function getBrowser() {
    if (browser) return browser;
    if (!launching) {
      launching = playwright.chromium
        .launch({
          headless: process.env.BROWSER_HEADFUL !== '1', // headful (Xvfb) = moins détectable
          ignoreDefaultArgs: ['--enable-automation'], // pas de bandeau/flag d'automatisation
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled', // navigator.webdriver = false
          ],
        })
        .then((b) => {
          browser = b;
          launching = null;
          b.on('disconnected', () => {
            browser = null;
          });
          return b;
        });
    }
    return launching;
  }

  // Renvoie true si l'upgrade nous concerne (/ws/browser), false sinon.
  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== '/ws/browser') return false;
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (sessions.size >= MAX_SESSIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, url));
    return true;
  }

  function sendJSON(session, obj) {
    if (session.ws.readyState === 1) session.ws.send(JSON.stringify(obj));
  }

  async function sendUrl(session) {
    if (!session.page || session.page.isClosed()) return;
    sendJSON(session, {
      type: 'url',
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
    });
  }

  async function startScreencast(session) {
    const q = QUALITY[session.qualityLevel] || QUALITY.auto;
    await session.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: q.quality,
      // On laisse passer la pleine résolution appareil (viewport x deviceScaleFactor),
      // bornée par MAX_DIM. Sinon la frame serait réduite à la taille CSS = flou.
      maxWidth: MAX_DIM,
      maxHeight: MAX_DIM,
      everyNthFrame: q.everyNth,
    });
  }

  /** Attache (ou ré-attache) le streaming + les entrées à une page donnée. */
  async function attachPage(session, page) {
    if (session.cdp) {
      try {
        await session.cdp.detach();
      } catch {
        /* ignore */
      }
      session.cdp = null;
    }
    session.page = page;
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    const cdp = await session.context.newCDPSession(page);
    session.cdp = cdp;
    cdp.on('Page.screencastFrame', async (frame) => {
      if (session.cdp !== cdp || session.closing) return;
      try {
        session.ws.send(Buffer.from(frame.data, 'base64'));
      } catch {
        /* socket fermé */
      }
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch {
        /* ignore */
      }
    });
    page.on('framenavigated', (f) => {
      if (session.page === page && f === page.mainFrame()) sendUrl(session);
    });
    page.on('close', () => onPageClose(session, page));
    await startScreencast(session);
    sendUrl(session);
  }

  /** Quand l'onglet actif se ferme, on bascule sur un autre (ou une page vierge). */
  async function onPageClose(session, page) {
    if (session.closing || session.page !== page) return;
    const others = session.context.pages().filter((p) => p !== page && !p.isClosed());
    try {
      if (others.length) {
        await attachPage(session, others[others.length - 1]);
      } else {
        const p = await session.context.newPage();
        await attachPage(session, p);
        await p.goto('about:blank').catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  async function handleConnection(ws, url) {
    const tor = url.searchParams.get('tor') === '1' && !!proxy;
    const session = {
      ws,
      tor,
      context: null,
      page: null,
      cdp: null,
      idleTimer: null,
      closing: false,
      dispW: 1024, // taille d'affichage côté client (px CSS)
      dispH: 640,
      width: 1280, // viewport de RENDU (recalculé selon la qualité)
      height: 720,
      qualityLevel: 'auto',
    };
    sessions.add(session);

    const bumpIdle = () => {
      clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => closeSession(session), IDLE_MS);
    };

    try {
      const b = await getBrowser();
      const ctxOpts = {
        viewport: { width: session.width, height: session.height },
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
        userAgent: REAL_UA,
        hasTouch: true, // active la prise en charge tactile (gestes natifs)
      };
      if (tor) ctxOpts.proxy = torProxyFor(proxy);
      session.context = await b.newContext(ctxOpts);
      await session.context.addInitScript(stealthScript).catch(() => {});
      const page = await session.context.newPage();
      await attachPage(session, page);
      // Suivi des popups / nouveaux onglets — enregistré APRÈS la 1re page pour
      // ne pas la ré-attacher en double (l'événement 'page' vaut aussi pour elle).
      session.context.on('page', async (newPage) => {
        try {
          await attachPage(session, newPage);
        } catch {
          /* ignore */
        }
      });
      sendJSON(session, { type: 'ready', tor, canNewIp: tor && controlAvailable });
      sendUrl(session);
    } catch (e) {
      sendJSON(session, { type: 'error', message: 'Démarrage du navigateur impossible : ' + e.message });
      return closeSession(session);
    }

    ws.on('message', (data, isBinary) => {
      bumpIdle();
      handleMessage(session, data, isBinary).catch((e) =>
        sendJSON(session, { type: 'error', message: e.message })
      );
    });
    ws.on('close', () => closeSession(session));
    ws.on('error', () => closeSession(session));
    bumpIdle();
  }

  async function handleMessage(session, data, isBinary) {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const page = session.page;
    if (!page) return;

    switch (msg.type) {
      case 'navigate': {
        let u = String(msg.url || '').trim();
        if (!u) break;
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        await page
          .goto(u, { waitUntil: 'domcontentloaded' })
          .catch((e) => sendJSON(session, { type: 'error', message: 'Navigation : ' + e.message }));
        break;
      }
      case 'back':
        await page.goBack().catch(() => {});
        break;
      case 'forward':
        await page.goForward().catch(() => {});
        break;
      case 'reload':
        await page.reload().catch(() => {});
        break;
      case 'mouse':
        await handleMouse(session, msg);
        break;
      case 'wheel':
        await page.mouse.wheel(msg.dx || 0, msg.dy || 0).catch(() => {});
        break;
      case 'touch':
        await handleTouch(session, msg);
        break;
      case 'text':
        await page.keyboard.insertText(String(msg.text || '')).catch(() => {});
        break;
      case 'key':
        await page.keyboard.press(String(msg.key || '')).catch(() => {});
        break;
      case 'resize':
        await handleResize(session, msg);
        break;
      case 'quality':
        await handleQuality(session, msg);
        break;
      case 'download':
        await handleDownload(session);
        break;
      case 'newip':
        await handleNewIp(session);
        break;
      // 'ping' (et inconnus) : ne fait rien, mais a relancé le minuteur d'inactivité.
    }
  }

  async function handleMouse(session, msg) {
    const m = session.page.mouse;
    const x = Math.round(Math.min(1, Math.max(0, msg.fx || 0)) * session.width);
    const y = Math.round(Math.min(1, Math.max(0, msg.fy || 0)) * session.height);
    const button = msg.button === 'right' ? 'right' : msg.button === 'middle' ? 'middle' : 'left';
    if (msg.action === 'move') await m.move(x, y).catch(() => {});
    else if (msg.action === 'down') {
      await m.move(x, y).catch(() => {});
      await m.down({ button }).catch(() => {});
    } else if (msg.action === 'up') await m.up({ button }).catch(() => {});
    else if (msg.action === 'click') {
      await m.move(x, y).catch(() => {});
      await m.down({ button }).catch(() => {});
      await m.up({ button }).catch(() => {});
    }
  }

  async function handleTouch(session, msg) {
    const map = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' };
    const type = map[msg.phase];
    if (!type) return;
    const touchPoints =
      type === 'touchEnd' || type === 'touchCancel'
        ? []
        : (msg.points || []).map((p) => ({
            x: Math.round(Math.min(1, Math.max(0, p.fx || 0)) * session.width),
            y: Math.round(Math.min(1, Math.max(0, p.fy || 0)) * session.height),
            id: p.id | 0,
          }));
    await session.cdp.send('Input.dispatchTouchEvent', { type, touchPoints }).catch(() => {});
  }

  // Viewport de rendu = ratio de l'affichage, petit côté = cible du niveau de
  // qualité, plafonné à MAX_DIM. Puis (re)démarre le screencast.
  async function applyVideo(session) {
    const q = QUALITY[session.qualityLevel] || QUALITY.auto;
    const dw = session.dispW;
    const dh = session.dispH;
    let scale = Math.min(2.5, Math.max(1, q.minSide / Math.min(dw, dh)));
    let rw = Math.round(dw * scale);
    let rh = Math.round(dh * scale);
    const over = Math.max(rw / MAX_DIM, rh / MAX_DIM, 1);
    rw = Math.round(rw / over);
    rh = Math.round(rh / over);
    session.width = rw;
    session.height = rh;
    try {
      await session.cdp.send('Page.stopScreencast').catch(() => {});
      await session.page.setViewportSize({ width: rw, height: rh });
      await startScreencast(session);
    } catch {
      /* ignore */
    }
  }

  async function handleResize(session, msg) {
    const dw = Math.max(240, Math.min(2000, msg.width | 0));
    const dh = Math.max(180, Math.min(2000, msg.height | 0));
    if (dw === session.dispW && dh === session.dispH) return;
    session.dispW = dw;
    session.dispH = dh;
    await applyVideo(session);
  }

  async function handleQuality(session, msg) {
    const level = QUALITY[msg.level] ? msg.level : 'auto';
    if (level === session.qualityLevel) return;
    session.qualityLevel = level;
    await applyVideo(session);
  }

  async function handleDownload(session) {
    const pageUrl = session.page.url();
    if (!/^https?:\/\//i.test(pageUrl)) {
      sendJSON(session, { type: 'error', message: 'Aucune page à télécharger.' });
      return;
    }
    let cookiesFile = null;
    try {
      const cookies = await session.context.cookies();
      if (cookies.length) {
        cookiesFile = path.join(tmpDir, `cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
        await fsp.writeFile(cookiesFile, toNetscape(cookies));
      }
    } catch {
      /* on télécharge quand même sans cookies */
    }
    const job = createDownloadJob({ url: pageUrl, quality: 'best', proxy: session.tor, cookiesFile });
    sendJSON(session, { type: 'download-started', jobId: job.id, url: pageUrl });
  }

  async function handleNewIp(session) {
    if (!session.tor || !controlAvailable) {
      sendJSON(session, { type: 'error', message: 'Changement d’IP indisponible (Tor requis).' });
      return;
    }
    try {
      await torControl.newIdentity({
        host: TOR_CTL_HOST,
        port: TOR_CTL_PORT,
        password: TOR_CONTROL_PASSWORD,
      });
      // Recharge la page pour repartir sur le nouveau circuit (nouvelle IP).
      await session.page.reload().catch(() => {});
      sendJSON(session, { type: 'newip', ok: true });
    } catch (e) {
      sendJSON(session, { type: 'error', message: 'Tor (nouvelle IP) : ' + e.message });
    }
  }

  async function closeSession(session) {
    if (session.closing) return;
    session.closing = true;
    sessions.delete(session);
    clearTimeout(session.idleTimer);
    try {
      if (session.context) await session.context.close();
    } catch {
      /* ignore */
    }
    try {
      session.ws.close();
    } catch {
      /* ignore */
    }
  }

  async function shutdown() {
    for (const s of sessions) await closeSession(s);
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
  }

  return { enabled: true, handleUpgrade, shutdown };
}

module.exports = { setup, available: !!playwright, REAL_UA, stealthScript, torProxyFor };
