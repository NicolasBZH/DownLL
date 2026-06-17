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
const cancelBtn = $('cancel');
const getFile = $('getfile');
const errorEl = $('error');
const installBtn = $('install');
const proxyRow = $('proxyRow');
const proxyToggle = $('proxyToggle');
const tabDl = $('tabDl');
const tabBrowser = $('tabBrowser');
const tabNeko = $('tabNeko');
const logoutBtn = $('logout');
const viewDl = $('view-dl');
const viewBrowser = $('view-browser');
const viewNeko = $('view-neko');
const nekoFrame = $('nekoFrame');
const nekoOpen = $('nekoOpen');
let nekoUrl = '';

const ALL_QUALITIES = [
  { key: 'best', label: 'Meilleure', height: Infinity },
  { key: '1080', label: '1080p', height: 1080 },
  { key: '720', label: '720p', height: 720 },
  { key: '480', label: '480p', height: 480 },
];

let current = null; // { url }
let selectedQuality = 'best';
let activeSource = null;
let currentJobId = null;

// Capacités du serveur : proxy (case Tor), auth (déconnexion), navigateur (onglet).
fetch('/api/health')
  .then((r) => {
    if (r.status === 401) {
      location.reload(); // session expirée -> le serveur servira l'écran de login
      throw new Error('auth');
    }
    return r.json();
  })
  .then((d) => {
    if (!d) return;
    if (d.proxy) proxyRow.classList.remove('hidden');
    if (d.auth) logoutBtn.classList.remove('hidden');
    if (d.browser) tabBrowser.classList.remove('hidden');
    if (d.neko && tabNeko) {
      nekoUrl = d.neko;
      tabNeko.classList.remove('hidden');
      if (nekoOpen) nekoOpen.href = nekoUrl;
    }
    window.DownLL = Object.assign(window.DownLL || {}, {
      caps: { proxy: !!d.proxy, browser: !!d.browser, hd: !!d.hd, neko: !!d.neko },
    });
    document.dispatchEvent(new CustomEvent('downll:caps', { detail: window.DownLL.caps }));
  })
  .catch(() => {});

const useProxy = () => !!(proxyToggle && proxyToggle.checked);

// --- Navigation entre vues (Téléchargeur / Navigateur / Live) ----------------
function showView(name) {
  const wide = name === 'browser' || name === 'neko';
  document.body.classList.toggle('browsing', wide);
  viewDl.classList.toggle('hidden', name !== 'dl');
  viewBrowser.classList.toggle('hidden', name !== 'browser');
  if (viewNeko) viewNeko.classList.toggle('hidden', name !== 'neko');
  tabDl.classList.toggle('active', name === 'dl');
  tabBrowser.classList.toggle('active', name === 'browser');
  if (tabNeko) tabNeko.classList.toggle('active', name === 'neko');
  // Charge l'iframe Neko au premier affichage seulement.
  if (name === 'neko' && nekoFrame && !nekoFrame.getAttribute('src') && nekoUrl) {
    nekoFrame.setAttribute('src', nekoUrl);
  }
  document.dispatchEvent(new CustomEvent('downll:view', { detail: { view: name } }));
}
tabDl.addEventListener('click', () => showView('dl'));
tabBrowser.addEventListener('click', () => showView('browser'));
if (tabNeko) tabNeko.addEventListener('click', () => showView('neko'));

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    location.reload();
  });
}

/**
 * Suit un téléchargement lancé depuis le navigateur intégré : bascule sur la vue
 * Téléchargeur et affiche la progression (réutilise le pipeline existant).
 */
function trackDownloadJob(jobId, label) {
  showView('dl');
  clearError();
  resetResultUI();
  thumb.classList.add('hidden');
  thumb.removeAttribute('src');
  titleEl.textContent = label || 'Téléchargement';
  subEl.textContent = 'Depuis le navigateur';
  qualitiesEl.parentElement.classList.add('hidden');
  downloadBtn.classList.add('hidden');
  result.classList.remove('hidden');
  progress.classList.remove('hidden');
  cancelBtn.classList.remove('hidden');
  progressText.textContent = 'En file d’attente…';
  trackProgress(jobId);
}

window.DownLL = Object.assign(window.DownLL || {}, { showView, trackDownloadJob });

function showError(msg) {
  let m = String(msg || '');
  // Mur anti-bot YouTube/Google : oriente vers la bonne méthode.
  if (/not a bot|sign in to confirm/i.test(m)) {
    m +=
      ' — Astuce : décoche « Via Tor » (les IP Tor sont bloquées par Google), ou ouvre l’onglet ' +
      '« 🌐 Navigateur », va sur la vidéo puis ⬇ (tes cookies de session passent).';
  }
  errorEl.textContent = m;
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
  barFill.classList.remove('indeterminate');
  progressText.textContent = '';
  cancelBtn.classList.add('hidden');
  cancelBtn.disabled = false;
  currentJobId = null;
  downloadBtn.disabled = false;
  downloadBtn.textContent = 'Télécharger';
  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }
}

function renderQualities(maxHeight) {
  qualitiesEl.parentElement.classList.remove('hidden');
  downloadBtn.classList.remove('hidden');
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
      body: JSON.stringify({ url, proxy: useProxy() }),
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
  cancelBtn.classList.remove('hidden');
  progressText.textContent = 'En file d’attente…';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: current.url, quality: selectedQuality, proxy: useProxy() }),
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
  currentJobId = jobId;
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
      // La fusion vidéo+audio (ffmpeg) a lieu après 100 % et n'a pas de %.
      if (data.phase === 'postprocess' || pct >= 100) {
        barFill.classList.add('indeterminate');
        progressText.textContent = 'Finalisation…';
      } else {
        barFill.classList.remove('indeterminate');
        const extra = [data.speed, data.eta && `ETA ${data.eta}`].filter(Boolean).join(' · ');
        progressText.textContent = `${pct}%${extra ? ' · ' + extra : ''}`;
      }
    } else if (data.status === 'queued') {
      progressText.textContent = 'En file d’attente…';
    } else if (data.status === 'done') {
      source.close();
      activeSource = null;
      barFill.classList.remove('indeterminate');
      barFill.style.width = '100%';
      progressText.textContent = 'Prêt !';
      cancelBtn.classList.add('hidden');
      downloadBtn.classList.add('hidden');
      getFile.href = `/api/file/${jobId}`;
      getFile.classList.remove('hidden');
      // Sur mobile, on déclenche directement l'enregistrement.
      getFile.click();
    } else if (data.status === 'canceled') {
      source.close();
      activeSource = null;
      resetResultUI();
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

// --- Annulation --------------------------------------------------------------
cancelBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  const id = currentJobId;
  cancelBtn.disabled = true;
  progressText.textContent = 'Annulation…';
  try {
    await fetch(`/api/cancel/${id}`, { method: 'POST' });
  } catch {
    /* le serveur finira par nettoyer le job de toute façon */
  }
  // On remet l'UI à zéro tout de suite, sans attendre l'écho SSE.
  resetResultUI();
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
