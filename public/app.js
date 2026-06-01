'use strict';

const $ = (id) => document.getElementById(id);
const form = $('form');
const urlInput = $('url');
const analyzeBtn = $('analyze');
const result = $('result');
const thumb = $('thumb');
const titleEl = $('title');
const subEl = $('sub');
const qualitiesEl = $('qualities');
const downloadBtn = $('download');
const progress = $('progress');
const barFill = $('barFill');
const progressText = $('progressText');
const getFile = $('getfile');
const errorEl = $('error');
const installBtn = $('install');

const ALL_QUALITIES = [
  { key: 'best', label: 'Meilleure', height: Infinity },
  { key: '1080', label: '1080p', height: 1080 },
  { key: '720', label: '720p', height: 720 },
  { key: '480', label: '480p', height: 480 },
];

let current = null; // { url }
let selectedQuality = 'best';
let activeSource = null;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function clearError() {
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
}

function fmtDuration(s) {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function resetResultUI() {
  progress.classList.add('hidden');
  getFile.classList.add('hidden');
  getFile.removeAttribute('href');
  barFill.style.width = '0%';
  progressText.textContent = '';
  downloadBtn.disabled = false;
  downloadBtn.textContent = 'Télécharger';
  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }
}

function renderQualities(maxHeight) {
  qualitiesEl.innerHTML = '';
  selectedQuality = 'best';
  for (const q of ALL_QUALITIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = q.label;
    btn.setAttribute('aria-pressed', String(q.key === selectedQuality));
    const unavailable = maxHeight && q.height !== Infinity && q.height > maxHeight;
    if (unavailable) {
      btn.disabled = true;
      btn.title = 'Résolution non disponible pour cette vidéo';
    }
    btn.addEventListener('click', () => {
      selectedQuality = q.key;
      [...qualitiesEl.children].forEach((c) =>
        c.setAttribute('aria-pressed', String(c === btn))
      );
    });
    qualitiesEl.appendChild(btn);
  }
}

// --- Analyse de l'URL --------------------------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  result.classList.add('hidden');
  resetResultUI();
  const url = urlInput.value.trim();
  if (!url) return;

  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<span class="spin"></span>Analyse…';
  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || 'Échec de l’analyse.');

    current = { url };
    titleEl.textContent = data.title;
    const bits = [];
    if (data.uploader) bits.push(data.uploader);
    if (data.duration) bits.push(fmtDuration(data.duration));
    if (data.extractor) bits.push(data.extractor);
    subEl.textContent = bits.join(' · ');
    if (data.thumbnail) {
      thumb.src = data.thumbnail;
      thumb.classList.remove('hidden');
    } else {
      thumb.removeAttribute('src');
      thumb.classList.add('hidden');
    }
    renderQualities(data.maxHeight);
    result.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analyser';
  }
});

// --- Téléchargement ----------------------------------------------------------
downloadBtn.addEventListener('click', async () => {
  if (!current) return;
  clearError();
  resetResultUI();
  downloadBtn.disabled = true;
  downloadBtn.innerHTML = '<span class="spin"></span>Préparation…';
  progress.classList.remove('hidden');
  progressText.textContent = 'En file d’attente…';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: current.url, quality: selectedQuality }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec du démarrage.');
    trackProgress(data.jobId);
  } catch (err) {
    showError(err.message);
    resetResultUI();
  }
});

function trackProgress(jobId) {
  const source = new EventSource(`/api/progress/${jobId}`);
  activeSource = source;
  source.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.status === 'downloading') {
      const pct = Math.round(data.percent || 0);
      barFill.style.width = `${pct}%`;
      const extra = [data.speed, data.eta && `ETA ${data.eta}`].filter(Boolean).join(' · ');
      progressText.textContent = `${pct}%${extra ? ' · ' + extra : ''}`;
    } else if (data.status === 'queued') {
      progressText.textContent = 'En file d’attente…';
    } else if (data.status === 'done') {
      source.close();
      activeSource = null;
      barFill.style.width = '100%';
      progressText.textContent = 'Prêt !';
      downloadBtn.classList.add('hidden');
      getFile.href = `/api/file/${jobId}`;
      getFile.classList.remove('hidden');
      // Sur mobile, on déclenche directement l'enregistrement.
      getFile.click();
    } else if (data.status === 'error') {
      source.close();
      activeSource = null;
      showError(data.error || 'Le téléchargement a échoué.');
      resetResultUI();
    }
  };
  source.onerror = () => {
    source.close();
    activeSource = null;
  };
}

getFile.addEventListener('click', () => {
  // Réaffiche le bouton "Télécharger" pour relancer si besoin.
  setTimeout(() => {
    downloadBtn.classList.remove('hidden');
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Télécharger à nouveau';
  }, 800);
});

// --- Installation PWA --------------------------------------------------------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove('hidden');
});
installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.classList.add('hidden');
});
window.addEventListener('appinstalled', () => installBtn.classList.add('hidden'));

// Aide à l'installation pour iOS (Safari ne propose pas de bouton « Installer »).
(function iosInstallHint() {
  const iosHint = $('iosHint');
  const iosHintClose = $('iosHintClose');
  if (!iosHint) return;

  const ua = navigator.userAgent || '';
  const isIos =
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  if (isIos && !isStandalone && localStorage.getItem('iosHintDismissed') !== '1') {
    iosHint.classList.remove('hidden');
  }
  iosHintClose.addEventListener('click', () => {
    iosHint.classList.add('hidden');
    try {
      localStorage.setItem('iosHintDismissed', '1');
    } catch {
      /* mode privé : on ignore */
    }
  });
})();

// --- Service worker ----------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
