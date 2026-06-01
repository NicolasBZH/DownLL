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

// ---------------------------------------------------------------------------
// Configuration (tout est surchargeable via variables d'environnement)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'downll');
const FILE_TTL_MS = parseInt(process.env.FILE_TTL_MS || '3600000', 10); // 1 h
const INFO_TIMEOUT_MS = parseInt(process.env.INFO_TIMEOUT_MS || '45000', 10);
const MAX_DURATION_S = parseInt(process.env.MAX_DURATION_S || '0', 10); // 0 = illimité
const MAX_FILESIZE = process.env.MAX_FILESIZE || ''; // ex: "3G" (vide = illimité)
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const TRUST_PROXY = process.env.TRUST_PROXY || '1'; // derrière Caddy/Nginx

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
    '--no-warnings',
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
  args.push(job.url);

  return new Promise((resolve) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    job.proc = child;
    let stderrTail = '';

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        const idx = line.indexOf('DLP ');
        if (idx === -1) continue;
        const [pct, speed, eta] = line.slice(idx + 4).split('|');
        const m = /([\d.]+)\s*%/.exec(pct || '');
        if (m) job.percent = Math.min(100, parseFloat(m[1]));
        job.speed = (speed || '').trim();
        job.eta = (eta || '').trim();
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
      if (code !== 0) {
        job.status = 'error';
        job.error = stderrTail.trim() || `yt-dlp a quitté avec le code ${code}.`;
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
app.use(express.json({ limit: '16kb' }));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, active: activeDownloads, jobs: jobs.size });
});

// --- Métadonnées de la vidéo --------------------------------------------------
app.post('/api/info', async (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'URL invalide.' });
  }
  try {
    const { stdout, stderr, code } = await runYtdlp(
      ['-J', '--no-playlist', '--no-warnings', '--no-color', url],
      { timeoutMs: INFO_TIMEOUT_MS }
    );
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
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'URL invalide.' });
  }
  if (!QUALITY_PRESETS[quality]) {
    return res.status(400).json({ error: 'Qualité inconnue.' });
  }
  const id = crypto.randomBytes(9).toString('hex');
  /** @type {Job} */
  const job = {
    id,
    url,
    quality,
    status: 'queued',
    percent: 0,
    speed: '',
    eta: '',
    fileName: null,
    filePath: null,
    error: null,
    proc: null,
    createdAt: Date.now(),
    readyAt: null,
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  res.json({ jobId: id });
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
    if (job.status === 'done' || job.status === 'error') {
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

// --- Statique + PWA -----------------------------------------------------------
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.listen(PORT, () => {
  console.log(`DownLL en écoute sur http://localhost:${PORT}`);
  console.log(`Dossier temporaire : ${TMP_DIR}`);
});

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {string} url
 * @property {string} quality
 * @property {'queued'|'downloading'|'done'|'error'} status
 * @property {number} percent
 * @property {string} speed
 * @property {string} eta
 * @property {string|null} fileName
 * @property {string|null} filePath
 * @property {string|null} error
 * @property {import('child_process').ChildProcess|null} proc
 * @property {number} createdAt
 * @property {number|null} readyAt
 */
