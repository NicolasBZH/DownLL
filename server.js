'use strict';

/**
 * DownLL — serveur de téléchargement vidéo basé sur yt-dlp.
 *
 * - Aucune base de données : l'état des jobs vit en mémoire (Map),
 *   les fichiers transitent par un dossier temporaire et sont supprimés
 *   après envoi (ou après expiration).
 * - yt-dlp est piloté en sous-processus (jamais via le shell -> pas
 *   d'injection de commande possible).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const auth = require('./lib/auth');
const browser = require('./lib/browser');
const hdBrowser = require('./lib/hd-browser');
const { zip } = require('./lib/zip');

// ---------------------------------------------------------------------------
// Configuration (tout est surchargeable via variables d'environnement)
// ---------------------------------------------------------------------------
// Marqueur de version du code (visible dans /api/health et les messages de
// diagnostic) : permet de vérifier d'un coup d'œil quelle build tourne vraiment.
const BUILD = 'deno-fix-5';
const PORT = parseInt(process.env.PORT || '3000', 10);
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'downll');
const FILE_TTL_MS = parseInt(process.env.FILE_TTL_MS || '3600000', 10); // 1 h
const INFO_TIMEOUT_MS = parseInt(process.env.INFO_TIMEOUT_MS || '45000', 10);
// Sonde de diagnostic (-J multi-clients) : plus longue, elle essaie plusieurs clients.
const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || '120000', 10);
const MAX_DURATION_S = parseInt(process.env.MAX_DURATION_S || '0', 10); // 0 = illimité
const MAX_FILESIZE = process.env.MAX_FILESIZE || ''; // ex: "3G" (vide = illimité)
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const TRUST_PROXY = process.env.TRUST_PROXY || '1'; // derrière Caddy/Nginx
// Proxy sortant optionnel pour yt-dlp (Tor, VPN, proxy HTTP/SOCKS).
// Ex: "socks5h://tor:9050". Vide = connexion directe.
const PROXY = process.env.PROXY || '';
// Impersonation TLS « navigateur » (nécessite curl_cffi côté yt-dlp).
// Ex: "chrome". Vide = désactivé. Contourne les blocages anti-bot (ex. 410
// PornHub). Activé par défaut dans l'image Docker (curl_cffi fourni).
const IMPERSONATE = process.env.IMPERSONATE || '';
// Navigateur intégré : exige l'auth (sinon ce serait un proxy ouvert) ET
// playwright installé. Désactivable explicitement avec BROWSER=0.
const BROWSER_ENABLED = auth.enabled() && browser.available && process.env.BROWSER !== '0';
// Mode HD (vidéo+son via ffmpeg/MSE) : nécessite le mode headful (Xvfb+PulseAudio).
const HD_ENABLED = BROWSER_ENABLED && hdBrowser.available && process.env.BROWSER_HEADFUL === '1';
// Jeton pour l'extension navigateur (en-tête x-downll-token). Nécessaire seulement
// si l'auth est activée ; sans auth, /api/download est ouvert et l'extension marche
// sans jeton. On propose donc l'extension dès que : auth désactivée OU jeton défini.
const DOWNLL_TOKEN = process.env.DOWNLL_TOKEN || '';
const EXT_ENABLED = !auth.enabled() || !!DOWNLL_TOKEN;

// ---------------------------------------------------------------------------
// État en mémoire
// ---------------------------------------------------------------------------
/** @type {Map<string, Job>} */
const jobs = new Map();
let activeDownloads = 0;
const queue = [];

fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isValidUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const QUALITY_PRESETS = {
  best: { label: 'Meilleure', height: null },
  '1080': { label: '1080p', height: 1080 },
  '720': { label: '720p', height: 720 },
  '480': { label: '480p', height: 480 },
};

function formatSelectorFor(quality) {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.best;
  if (preset.height == null) {
    return 'bv*+ba/b';
  }
  const h = preset.height;
  return `bv*[height<=${h}]+ba/b[height<=${h}]`;
}

/**
 * Construit les arguments `--proxy` pour yt-dlp si un proxy est configuré.
 * Pour Tor (socks5), on injecte un identifiant SOCKS unique (`token`) afin de
 * forcer un circuit — et donc une IP de sortie — différent par requête
 * (Tor isole les flux par IsolateSOCKSAuth, actif par défaut).
 * @param {string} token  Jeton d'isolation (ex: id du job).
 * @returns {string[]}
 */
function proxyArgsFor(token) {
  if (!PROXY) return [];
  let url = PROXY;
  // Sur un proxy SOCKS sans auth explicite, on rend le circuit unique par token.
  if (/^socks5h?:\/\//i.test(PROXY) && !PROXY.includes('@')) {
    url = PROXY.replace(/^(socks5h?:\/\/)/i, `$1dll${token}:x@`);
  }
  return ['--proxy', url];
}

/** Args d'impersonation TLS pour yt-dlp (vide si non configuré). */
function impersonateArgs() {
  return IMPERSONATE ? ['--impersonate', IMPERSONATE] : [];
}

// Élargit les « player clients » YouTube. Le client `web` authentifié (cookies)
// ne renvoie souvent que des flux SABR sans URL téléchargeable -> « Requested
// format is not available ». Les clients `tv`/`web_safari` fournissent des formats
// téléchargeables, y compris pour les vidéos à restriction d'âge avec cookies.
// L'arg est ignoré par les autres extracteurs, donc sans effet hors YouTube.
const YT_PLAYER_CLIENTS = process.env.YT_PLAYER_CLIENTS || 'default,tv,web_safari,mweb,tv_embedded';
function youtubeArgs() {
  return YT_PLAYER_CLIENTS ? ['--extractor-args', `youtube:player_client=${YT_PLAYER_CLIENTS}`] : [];
}

/** Args communs de sélection de source (impersonation, clients YT, cookies, proxy). */
function sourceArgs(job) {
  const a = [...impersonateArgs(), ...youtubeArgs()];
  if (job.cookiesFile) a.push('--cookies', job.cookiesFile);
  if (job.proxy) a.push(...proxyArgsFor(job.id));
  return a;
}

/**
 * Sonde les formats réellement disponibles (via -J) quand le sélecteur n'a rien
 * trouvé. Permet de distinguer un flux protégé sans piste vidéo (SABR) d'un
 * simple souci de sélecteur, et de donner un message d'erreur actionnable.
 */
const PROBE_SIGNAL_RE = /sabr|po.?token|missing a url|only images|sign in|not a bot|nsig|player.?client|skipp|unavailable/i;

async function probeFormats(job) {
  // Sans --no-warnings : on veut justement les avertissements de yt-dlp.
  const args = ['-J', '--no-playlist', '--no-color', ...sourceArgs(job), job.url];
  const { stdout, stderr, code } = await runYtdlp(args, { timeoutMs: PROBE_TIMEOUT_MS });
  const notes = (stderr || '')
    .split('\n')
    .filter((l) => PROBE_SIGNAL_RE.test(l))
    .map((l) => l.replace(/^\s*(WARNING|ERROR):\s*(\[[\w.:-]+\]\s*)?/i, '').trim())
    .filter(Boolean)
    .slice(-3);
  let parsed = false;
  let total = 0;
  let heights = [];
  let hasVideo = false;
  if (code === 0 && stdout) {
    try {
      const data = JSON.parse(stdout);
      const fmts = Array.isArray(data.formats) ? data.formats : [];
      total = fmts.length;
      const vids = fmts.filter((f) => f.vcodec && f.vcodec !== 'none');
      hasVideo = vids.length > 0;
      heights = [...new Set(vids.map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
      parsed = true;
    } catch {
      /* JSON illisible : parsed reste false */
    }
  }
  return { ok: parsed, total, hasVideo, heights, notes };
}

/** Lance yt-dlp et renvoie {stdout, stderr, code} ; tue le process au timeout. */
function runYtdlp(args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('timeout'));
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

// ---------------------------------------------------------------------------
// Création d'un job (utilisé par l'API ET par le navigateur intégré)
// ---------------------------------------------------------------------------
function createJob({ url, quality = 'best', proxy = false, cookiesFile = null }) {
  const id = crypto.randomBytes(9).toString('hex');
  /** @type {Job} */
  const job = {
    id,
    url,
    quality: QUALITY_PRESETS[quality] ? quality : 'best',
    status: 'queued',
    percent: 0,
    phase: 'queued',
    speed: '',
    eta: '',
    fileName: null,
    filePath: null,
    error: null,
    proc: null,
    canceled: false,
    proxy: !!proxy,
    cookiesFile,
    createdAt: Date.now(),
    readyAt: null,
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  return job;
}

// ---------------------------------------------------------------------------
// File d'attente de téléchargements (limite la concurrence)
// ---------------------------------------------------------------------------
function pump() {
  while (activeDownloads < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.status !== 'queued') continue;
    activeDownloads++;
    startDownload(job).finally(() => {
      activeDownloads--;
      pump();
    });
  }
}

async function startDownload(job) {
  job.status = 'downloading';
  const jobDir = path.join(TMP_DIR, job.id);
  await fsp.mkdir(jobDir, { recursive: true });

  const args = [
    '--no-playlist',
    '--newline',
    '--no-color',
    // Pas de --no-warnings : sur échec, les avertissements yt-dlp (SABR, PO-token,
    // « missing a url », « only images ») expliquent pourquoi aucun format ne matche.
    '--restrict-filenames',
    '--progress-template',
    'download:DLP %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-f',
    formatSelectorFor(job.quality),
    '--merge-output-format',
    'mp4',
    '-o',
    path.join(jobDir, '%(title)s.%(ext)s'),
  ];
  if (MAX_FILESIZE) args.push('--max-filesize', MAX_FILESIZE);
  if (MAX_DURATION_S > 0) args.push('--match-filter', `duration<=${MAX_DURATION_S}`);
  args.push(...sourceArgs(job), job.url);

  return new Promise((resolve) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    job.proc = child;
    let stderrTail = '';

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        const idx = line.indexOf('DLP ');
        if (idx !== -1) {
          const [pct, speed, eta] = line.slice(idx + 4).split('|');
          const m = /([\d.]+)\s*%/.exec(pct || '');
          if (m) job.percent = Math.min(100, parseFloat(m[1]));
          job.speed = (speed || '').trim();
          job.eta = (eta || '').trim();
          job.phase = 'download';
          continue;
        }
        // Post-traitement (fusion vidéo+audio, remux, fixup) : il a lieu après
        // le téléchargement, sans pourcentage -> on signale « finalisation ».
        if (/\[(Merger|VideoRemuxer|VideoConvertor|ExtractAudio|Fixup\w*|Embed\w*)\]/.test(line)) {
          job.phase = 'postprocess';
          job.speed = '';
          job.eta = '';
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    child.on('error', (err) => {
      job.status = 'error';
      job.error = `Impossible de lancer yt-dlp : ${err.message}`;
      resolve();
    });

    child.on('close', async (code) => {
      job.proc = null;
      if (job.canceled) {
        job.status = 'canceled';
        await cleanupJob(job);
        return resolve();
      }
      if (code !== 0) {
        job.status = 'error';
        const raw = stderrTail.trim() || `yt-dlp a quitté avec le code ${code}.`;
        job.error = raw;
        // Sélecteur non satisfait : on sonde les formats réels et on renvoie
        // TOUJOURS un message versionné (le texte anglais brut ne peut plus fuiter :
        // s'il réapparaît tel quel, c'est que l'ancien code tourne encore).
        if (/requested format is not available/i.test(raw)) {
          // Avertissements yt-dlp du téléchargement lui-même (maintenant capturés).
          const dlSignals = raw
            .split('\n')
            .filter((l) => PROBE_SIGNAL_RE.test(l))
            .map((l) => l.replace(/^\s*(WARNING|ERROR):\s*(\[[\w.:-]+\]\s*)?/i, '').trim())
            .filter(Boolean);
          let p = null;
          try {
            p = await probeFormats(job);
          } catch (e) {
            console.log(`[diag ${BUILD} ${job.id}] sonde : ${e.message}`);
          }
          const notes = [...new Set([...(p ? p.notes : []), ...dlSignals])].slice(-3).join(' ; ');
          console.log(
            `[diag ${BUILD} ${job.id}] ${job.url} probe=${JSON.stringify(p)} dlSignals=${JSON.stringify(dlSignals)}`
          );
          const sabr = /sabr|missing a url|only images/i.test(raw + ' ' + notes);
          if (p && p.ok && p.hasVideo) {
            const res = p.heights.length ? p.heights.join('p, ') + 'p' : `${p.total} formats`;
            job.error = `[${BUILD}] Formats vidéo présents (${res}) mais sélection ratée — bug de sélecteur, signale-le.`;
          } else if (sabr) {
            job.error = `[${BUILD}] YouTube force le SABR (aucune URL de téléchargement direct) pour cette vidéo connectée → jeton PO requis.${notes ? ' Détail : ' + notes : ''}`;
          } else if (notes) {
            job.error = `[${BUILD}] Téléchargement refusé : ${notes}`;
          } else if (p && p.ok) {
            job.error = `[${BUILD}] Aucune piste vidéo (${p.total} formats vus, tous audio/protégés).`;
          } else {
            job.error = `[${BUILD}] Format indisponible ; diagnostic brut : ${raw.split('\n').filter(Boolean).slice(-1)[0] || 'n/a'}`;
          }
        }
        return resolve();
      }
      try {
        const files = (await fsp.readdir(jobDir)).filter((f) => !f.endsWith('.part'));
        // On privilégie le .mp4 final, sinon le plus gros fichier.
        let chosen = files.find((f) => f.toLowerCase().endsWith('.mp4')) || null;
        if (!chosen && files.length) {
          const sized = await Promise.all(
            files.map(async (f) => ({
              f,
              size: (await fsp.stat(path.join(jobDir, f))).size,
            }))
          );
          sized.sort((a, b) => b.size - a.size);
          chosen = sized[0].f;
        }
        if (!chosen) {
          job.status = 'error';
          job.error = 'Aucun fichier produit.';
          return resolve();
        }
        job.filePath = path.join(jobDir, chosen);
        job.fileName = chosen;
        job.percent = 100;
        job.status = 'done';
        job.readyAt = Date.now();
      } catch (e) {
        job.status = 'error';
        job.error = `Erreur post-traitement : ${e.message}`;
      }
      resolve();
    });
  });
}

async function cleanupJob(job) {
  jobs.delete(job.id);
  try {
    await fsp.rm(path.join(TMP_DIR, job.id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (job.cookiesFile) {
    try {
      await fsp.rm(job.cookiesFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// Nettoyage périodique des jobs expirés.
setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    const age = now - job.createdAt;
    const stale = job.status === 'done' && job.readyAt && now - job.readyAt > FILE_TTL_MS;
    if (stale || age > FILE_TTL_MS * 4) {
      if (job.proc) job.proc.kill('SIGKILL');
      cleanupJob(job);
    }
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', TRUST_PROXY === 'false' ? false : Number(TRUST_PROXY) || TRUST_PROXY);
app.use(express.json({ limit: '256kb' })); // 256kb : marge pour un cookies.txt

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// --- Authentification (login/logout/health restent publics) ------------------
app.post('/api/login', (req, res) => {
  if (!auth.enabled()) return res.json({ ok: true });
  if (!auth.checkPassword(req.body && req.body.password)) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  auth.issueCookie(res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    active: activeDownloads,
    jobs: jobs.size,
    proxy: !!PROXY,
    auth: auth.enabled(),
    authed: auth.isAuthed(req),
    browser: BROWSER_ENABLED,
    hd: HD_ENABLED,
    ext: EXT_ENABLED,
    build: BUILD,
  });
});

// --- Mur d'authentification (tout le reste) ----------------------------------
app.use((req, res, next) => {
  if (auth.isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  // Page : on sert l'écran de connexion (autonome, sans assets externes).
  res.status(401).sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- Métadonnées de la vidéo --------------------------------------------------
app.post('/api/info', async (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  const useProxy = !!(req.body && req.body.proxy) && !!PROXY;
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'URL invalide.' });
  }
  try {
    const args = ['-J', '--no-playlist', '--no-warnings', '--no-color'];
    args.push(...impersonateArgs());
    args.push(...youtubeArgs());
    if (useProxy) args.push(...proxyArgsFor(crypto.randomBytes(6).toString('hex')));
    args.push(url);
    const { stdout, stderr, code } = await runYtdlp(args, { timeoutMs: INFO_TIMEOUT_MS });
    if (code !== 0) {
      return res.status(422).json({
        error: 'Impossible de lire cette URL.',
        detail: (stderr || '').split('\n').filter(Boolean).pop() || '',
      });
    }
    const data = JSON.parse(stdout);
    const heights = [
      ...new Set(
        (data.formats || [])
          .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
          .map((f) => f.height)
      ),
    ].sort((a, b) => b - a);
    res.json({
      title: data.title || 'Vidéo',
      uploader: data.uploader || data.channel || '',
      duration: data.duration || null,
      thumbnail: data.thumbnail || null,
      extractor: data.extractor_key || data.extractor || '',
      maxHeight: heights[0] || null,
    });
  } catch (e) {
    let msg = e.message;
    if (e.message === 'timeout') msg = 'Délai dépassé en lisant l’URL.';
    else if (e.code === 'ENOENT') msg = 'yt-dlp est introuvable sur le serveur (binaire non installé).';
    res.status(500).json({ error: msg });
  }
});

// --- Lancement d'un téléchargement -------------------------------------------
app.post('/api/download', (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  const quality = (req.body && req.body.quality) || 'best';
  const useProxy = !!(req.body && req.body.proxy) && !!PROXY;
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'URL invalide.' });
  }
  if (!QUALITY_PRESETS[quality]) {
    return res.status(400).json({ error: 'Qualité inconnue.' });
  }
  // Cookies optionnels (extension navigateur) : texte Netscape -> fichier --cookies.
  let cookiesFile = null;
  const cookiesText = req.body && typeof req.body.cookies === 'string' ? req.body.cookies : '';
  if (cookiesText && cookiesText.length < 200000 && /\t/.test(cookiesText)) {
    cookiesFile = path.join(TMP_DIR, `cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
    try {
      fs.writeFileSync(cookiesFile, cookiesText);
    } catch {
      cookiesFile = null;
    }
  }
  const job = createJob({ url, quality, proxy: useProxy, cookiesFile });
  res.json({ jobId: job.id });
});

// --- Annulation d'un téléchargement ------------------------------------------
app.post('/api/cancel/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job introuvable.' });
  // Déjà terminé : rien à annuler, on renvoie l'état tel quel.
  if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') {
    return res.json({ ok: true, status: job.status });
  }
  job.canceled = true;
  job.status = 'canceled';
  if (job.proc) {
    // Le SIGKILL déclenche le handler `close` -> cleanupJob + libère un slot.
    job.proc.kill('SIGKILL');
  } else {
    // Encore en file d'attente (pump l'ignorera) : on nettoie tout de suite.
    cleanupJob(job);
  }
  res.json({ ok: true, status: 'canceled' });
});

// --- Liste de tous les téléchargements (y compris ceux lancés par l'extension) -
app.get('/api/jobs', (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => ({
      id: j.id,
      url: j.url,
      status: j.status,
      percent: j.percent,
      phase: j.phase,
      speed: j.speed,
      eta: j.eta,
      fileName: j.fileName,
      error: j.error,
      proxy: j.proxy,
      createdAt: j.createdAt,
    }));
  res.json({ jobs: list });
});

// --- Progression en temps réel (SSE) -----------------------------------------
app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  const send = () => {
    res.write(
      `data: ${JSON.stringify({
        status: job.status,
        percent: job.percent,
        phase: job.phase,
        speed: job.speed,
        eta: job.eta,
        fileName: job.fileName,
        error: job.error,
      })}\n\n`
    );
  };
  send();
  const iv = setInterval(() => {
    send();
    if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') {
      clearInterval(iv);
      res.end();
    }
  }, 500);
  req.on('close', () => clearInterval(iv));
});

// --- Récupération du fichier --------------------------------------------------
app.get('/api/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.filePath) {
    return res.status(404).send('Fichier introuvable ou expiré.');
  }
  res.download(job.filePath, job.fileName, (err) => {
    // On supprime le fichier après l'envoi (réussi ou non) pour ne rien conserver.
    if (!err) cleanupJob(job);
  });
});

// --- Extension navigateur : ZIP pré-configuré (URL + jeton injectés) ---------
app.get('/api/extension.zip', (req, res) => {
  if (!EXT_ENABLED) return res.status(404).end();
  try {
    const extDir = path.join(__dirname, 'extension');
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const config = `self.DOWNLL_DEFAULTS = ${JSON.stringify({ url: `${proto}://${host}`, token: DOWNLL_TOKEN })};\n`;
    const files = [
      { name: 'manifest.json', data: fs.readFileSync(path.join(extDir, 'manifest.json')) },
      { name: 'popup.html', data: fs.readFileSync(path.join(extDir, 'popup.html')) },
      { name: 'popup.js', data: fs.readFileSync(path.join(extDir, 'popup.js')) },
      { name: 'icon128.png', data: fs.readFileSync(path.join(extDir, 'icon128.png')) },
      { name: 'config.js', data: Buffer.from(config, 'utf8') },
    ];
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="downll-extension.zip"');
    res.end(zip(files));
  } catch (e) {
    res.status(500).json({ error: 'Extension indisponible : ' + e.message });
  }
});

// --- Statique + PWA -----------------------------------------------------------
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const server = app.listen(PORT, () => {
  console.log(`DownLL en écoute sur http://localhost:${PORT}`);
  console.log(`Dossier temporaire : ${TMP_DIR}`);
  console.log(`Authentification : ${auth.enabled() ? 'activée' : 'désactivée'}`);
});

// --- Navigateur intégré (WebSocket /ws/browser et /ws/hd) --------------------
let browserHandle = { enabled: false };
let hdHandle = { enabled: false };
if (BROWSER_ENABLED) {
  const opts = { isAuthed: auth.isAuthed, createDownloadJob: createJob, proxy: PROXY, tmpDir: TMP_DIR };
  browserHandle = browser.setup(opts);
  if (HD_ENABLED) hdHandle = hdBrowser.setup(opts);
  // Un seul écouteur d'upgrade WebSocket -> route par chemin (/ws/browser, /ws/hd).
  server.on('upgrade', (req, socket, head) => {
    if (browserHandle.handleUpgrade && browserHandle.handleUpgrade(req, socket, head)) return;
    if (hdHandle.handleUpgrade && hdHandle.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });
  if (browserHandle.enabled) {
    console.log('Navigateur intégré : activé.' + (hdHandle.enabled ? ' (+ mode HD son/vidéo)' : ''));
  }
} else if (auth.enabled() && !browser.available) {
  console.log('Navigateur intégré : indisponible (playwright non installé).');
} else if (!auth.enabled()) {
  console.log('Navigateur intégré : désactivé (nécessite AUTH_PASSWORD).');
}

// ---------------------------------------------------------------------------
// Arrêt propre : on tue les yt-dlp en cours et on ferme le serveur avant de
// rendre la main à systemd/Docker (sinon les sous-processus restent orphelins).
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} reçu — arrêt en cours…`);
  for (const job of jobs.values()) {
    if (job.proc) {
      try {
        job.proc.kill('SIGKILL');
      } catch {
        /* déjà mort */
      }
    }
  }
  if (browserHandle.shutdown) browserHandle.shutdown();
  if (hdHandle.shutdown) hdHandle.shutdown();
  server.close(() => process.exit(0));
  // Filet de sécurité si des connexions (SSE ouvertes) tardent à se fermer.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {string} url
 * @property {string} quality
 * @property {'queued'|'downloading'|'done'|'error'|'canceled'} status
 * @property {number} percent
 * @property {'queued'|'download'|'postprocess'} phase
 * @property {string} speed
 * @property {string} eta
 * @property {string|null} fileName
 * @property {string|null} filePath
 * @property {string|null} error
 * @property {import('child_process').ChildProcess|null} proc
 * @property {boolean} canceled
 * @property {boolean} proxy
 * @property {string|null} cookiesFile
 * @property {number} createdAt
 * @property {number|null} readyAt
 */
