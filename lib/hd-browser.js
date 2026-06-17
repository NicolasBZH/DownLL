'use strict';

/**
 * Navigateur HD « + son » : un Chromium dédié (chromeless via --app) tourne sur
 * un écran virtuel Xvfb (:100), son audio routé vers un sink PulseAudio. ffmpeg
 * capture écran + audio -> fragmented MP4 (H.264/AAC) envoyé en WebSocket binaire,
 * lu côté client par MediaSource (<video>) -> VIDÉO FLUIDE + SON, en TCP/WS seul.
 *
 * Une seule session HD à la fois (capture plein écran d'un display dédié).
 * Nécessite BROWSER_HEADFUL=1 (Xvfb + PulseAudio démarrés par l'entrypoint).
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const torControl = require('./tor-control');
const { REAL_UA, stealthScript, torProxyFor } = require('./browser');

let playwright = null;
try {
  playwright = require('playwright');
} catch {
  playwright = null;
}

const HD_DISPLAY = process.env.HD_DISPLAY || ':100';
const HD_SINK = process.env.HD_SINK || 'hd';
const HD_W = parseInt(process.env.HD_WIDTH || '1280', 10);
const HD_H = parseInt(process.env.HD_HEIGHT || '720', 10);
// L'écran virtuel est un peu plus haut que la zone utile : on y loge la barre
// Chrome, qu'on rogne ensuite via ffmpeg (offset = outerHeight-innerHeight).
const HD_CHROME = 80;
const HD_DISP_H = HD_H + HD_CHROME;
const IDLE_MS = parseInt(process.env.BROWSER_IDLE_MS || '300000', 10);
const NAV_TIMEOUT = parseInt(process.env.BROWSER_NAV_TIMEOUT_MS || '30000', 10);

const TOR_CONTROL = process.env.TOR_CONTROL || '';
const TOR_CONTROL_PASSWORD = process.env.TOR_CONTROL_PASSWORD || '';
const TOR_CTL_HOST = TOR_CONTROL.split(':')[0] || '';
const TOR_CTL_PORT = parseInt(TOR_CONTROL.split(':')[1] || '9051', 10);

function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', ''];
  for (const c of cookies) {
    const sub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const exp = Math.floor(c.expires && c.expires > 0 ? c.expires : 0);
    lines.push([c.domain, sub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function setup({ isAuthed, createDownloadJob, proxy, tmpDir }) {
  // HD = headful obligatoire (Xvfb + PulseAudio). Sinon indisponible.
  if (!playwright || process.env.BROWSER_HEADFUL !== '1') {
    return { enabled: false };
  }
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  const controlAvailable = !!proxy && !!TOR_CONTROL && !!TOR_CONTROL_PASSWORD;
  let active = null; // une seule session HD

  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== '/ws/hd') return false;
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (active) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => startHd(ws, url));
    return true;
  }

  const sendJSON = (s, o) => s.ws.readyState === 1 && s.ws.send(JSON.stringify(o));

  async function sendUrl(s) {
    if (!s.page || s.page.isClosed()) return;
    sendJSON(s, { type: 'url', url: s.page.url(), title: await s.page.title().catch(() => '') });
  }

  async function startHd(ws, url) {
    const tor = url.searchParams.get('tor') === '1' && !!proxy;
    const session = { ws, tor, browser: null, ctx: null, page: null, cdp: null, ff: null, idleTimer: null, closing: false };
    active = session;
    const bump = () => {
      clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => closeHd(session), IDLE_MS);
    };

    try {
      // Fenêtre normale qui remplit l'écran virtuel (HD_W x HD_DISP_H). La barre
      // Chrome (en haut) sera rognée par ffmpeg. viewport:null = taille réelle.
      const profile = path.join(tmpDir, 'hd-profile-' + crypto.randomBytes(4).toString('hex'));
      const ctxOpts = {
        headless: false,
        ignoreDefaultArgs: ['--enable-automation'],
        env: { ...process.env, DISPLAY: HD_DISPLAY, PULSE_SINK: HD_SINK, TZ: 'Europe/Paris' },
        viewport: null,
        locale: 'fr-FR',
        userAgent: REAL_UA,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--window-position=0,0',
          `--window-size=${HD_W},${HD_DISP_H}`,
          '--autoplay-policy=no-user-gesture-required',
        ],
      };
      if (tor) ctxOpts.proxy = torProxyFor(proxy);
      session.ctx = await playwright.chromium.launchPersistentContext(profile, ctxOpts);
      await session.ctx.addInitScript(stealthScript).catch(() => {});
      session.page = session.ctx.pages()[0] || (await session.ctx.newPage());
      session.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      session.cdp = await session.ctx.newCDPSession(session.page);
      // Hauteur réelle de la barre Chrome -> offset de rognage ffmpeg.
      const chromeH = await session.page
        .evaluate(() => Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0)))
        .catch(() => HD_CHROME);
      session.cropY = Math.min(Math.max(0, Math.round(chromeH) + 2), HD_DISP_H - HD_H);
      session.page.on('framenavigated', (f) => {
        if (session.page && f === session.page.mainFrame()) sendUrl(session);
      });

      startFfmpeg(session);

      sendJSON(session, { type: 'ready', tor, canNewIp: tor && controlAvailable, w: HD_W, h: HD_H });
      sendUrl(session);
    } catch (e) {
      sendJSON(session, { type: 'error', message: 'HD : ' + e.message });
      return closeHd(session);
    }

    ws.on('message', (data, isBinary) => {
      bump();
      if (!isBinary) handleMsg(session, data).catch((e) => sendJSON(session, { type: 'error', message: e.message }));
    });
    ws.on('close', () => closeHd(session));
    ws.on('error', () => closeHd(session));
    bump();
  }

  function startFfmpeg(session) {
    const cropY = session.cropY || 0;
    const ff = spawn(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-fflags', 'nobuffer',
        '-f', 'x11grab', '-draw_mouse', '1', '-video_size', `${HD_W}x${HD_DISP_H}`, '-framerate', '30', '-i', HD_DISPLAY,
        '-f', 'pulse', '-fragment_size', '512', '-i', `${HD_SINK}.monitor`,
        '-vf', `crop=${HD_W}:${HD_H}:0:${cropY}`, // enlève la barre Chrome (en haut)
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-profile:v', 'baseline', '-g', '30',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-max_interleave_delta', '0', // ne retient pas la vidéo en attendant l'audio (~ -1 s)
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '60000', // fragments ~60 ms -> faible latence
        '-flush_packets', '1',
        '-f', 'mp4', 'pipe:1',
      ],
      { env: process.env }
    );
    session.ff = ff;
    ff.stdout.on('data', (chunk) => {
      if (session.ws.readyState === 1) {
        try {
          session.ws.send(chunk);
        } catch {
          /* socket fermé */
        }
      }
    });
    ff.stderr.on('data', () => {
      /* erreurs ffmpeg ignorées (loglevel error) */
    });
    ff.on('close', () => {
      if (!session.closing) closeHd(session);
    });
  }

  async function handleMsg(session, data) {
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
        await page.goto(u, { waitUntil: 'domcontentloaded' }).catch((e) =>
          sendJSON(session, { type: 'error', message: 'Navigation : ' + e.message })
        );
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
      case 'text':
        await page.keyboard.insertText(String(msg.text || '')).catch(() => {});
        break;
      case 'key':
        await page.keyboard.press(String(msg.key || '')).catch(() => {});
        break;
      case 'download':
        await handleDownload(session);
        break;
      case 'newip':
        await handleNewIp(session);
        break;
    }
  }

  async function handleMouse(session, msg) {
    const m = session.page.mouse;
    const x = Math.round(Math.min(1, Math.max(0, msg.fx || 0)) * HD_W);
    const y = Math.round(Math.min(1, Math.max(0, msg.fy || 0)) * HD_H);
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

  async function handleDownload(session) {
    const pageUrl = session.page.url();
    if (!/^https?:\/\//i.test(pageUrl)) {
      sendJSON(session, { type: 'error', message: 'Aucune page à télécharger.' });
      return;
    }
    let cookiesFile = null;
    try {
      const cookies = await session.ctx.cookies();
      if (cookies.length) {
        cookiesFile = path.join(tmpDir, `cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
        await fsp.writeFile(cookiesFile, toNetscape(cookies));
      }
    } catch {
      /* sans cookies */
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
      await torControl.newIdentity({ host: TOR_CTL_HOST, port: TOR_CTL_PORT, password: TOR_CONTROL_PASSWORD });
      await session.page.reload().catch(() => {});
      sendJSON(session, { type: 'newip', ok: true });
    } catch (e) {
      sendJSON(session, { type: 'error', message: 'Tor : ' + e.message });
    }
  }

  async function closeHd(session) {
    if (session.closing) return;
    session.closing = true;
    if (active === session) active = null;
    clearTimeout(session.idleTimer);
    try {
      if (session.ff) session.ff.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      if (session.ctx) await session.ctx.close();
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
    if (active) await closeHd(active);
  }

  return { enabled: true, handleUpgrade, shutdown };
}

module.exports = { setup, available: !!playwright };
