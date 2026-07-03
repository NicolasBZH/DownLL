'use strict';

const $ = (id) => document.getElementById(id);
function setStatus(text, kind) {
  const s = $('status');
  s.textContent = text || '';
  s.style.color = kind === 'err' ? '#ff8a99' : kind === 'ok' ? '#4fd18b' : '#9aa3c7';
}
// Réglages : d'abord ce qui est enregistré, sinon les défauts pré-injectés
// (config.js) quand l'extension a été téléchargée depuis DownLL.
const getCfg = () =>
  new Promise((r) =>
    chrome.storage.local.get(['url', 'token'], (s) => {
      const d = self.DOWNLL_DEFAULTS || {};
      r({ url: s.url || d.url || '', token: s.token || d.token || '' });
    })
  );

/** Cookies Chrome -> format Netscape cookies.txt (comme --cookies de yt-dlp). */
function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', ''];
  for (const c of cookies) {
    let domain = c.domain;
    const includeSub = c.hostOnly ? 'FALSE' : 'TRUE';
    if (!c.hostOnly && !domain.startsWith('.')) domain = '.' + domain;
    const exp = Math.floor(c.expirationDate || 0);
    lines.push([domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Cookies du domaine courant + youtube.com + google.com (age-restricted YouTube). */
async function collectCookies(tabUrl) {
  const domains = new Set(['youtube.com', 'google.com']);
  try {
    domains.add(new URL(tabUrl).hostname);
  } catch {
    /* ignore */
  }
  const all = [];
  const seen = new Set();
  for (const d of domains) {
    let cs = [];
    try {
      cs = await chrome.cookies.getAll({ domain: d });
    } catch {
      cs = [];
    }
    for (const c of cs) {
      const k = c.domain + '|' + c.name + '|' + c.path;
      if (!seen.has(k)) {
        seen.add(k);
        all.push(c);
      }
    }
  }
  return all;
}

$('dl').addEventListener('click', async () => {
  const cfg = await getCfg();
  if (!cfg.url) {
    setStatus('Renseigne l’URL de ton serveur DownLL (Réglages).', 'err');
    $('cfg').classList.remove('hidden');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) {
    setStatus('Cet onglet n’est pas téléchargeable.', 'err');
    return;
  }
  setStatus('Lecture des cookies…');
  try {
    const origin = new URL(tab.url).origin + '/*';
    await chrome.permissions.request({
      origins: [origin, '*://*.youtube.com/*', '*://*.google.com/*'],
    });
  } catch {
    /* permission déjà accordée / refusée : on tente quand même */
  }
  const cookies = await collectCookies(tab.url);
  setStatus('Envoi à DownLL…');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.token) headers['x-downll-token'] = cfg.token; // requis seulement si l'auth est activée
    const res = await fetch(cfg.url.replace(/\/+$/, '') + '/api/download', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: tab.url, cookies: toNetscape(cookies) }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.jobId) setStatus('✅ Téléchargement lancé sur DownLL !', 'ok');
    else setStatus('Erreur : ' + (d.error || res.status), 'err');
  } catch (e) {
    setStatus('Erreur réseau : ' + e.message, 'err');
  }
});

// --- Réglages ---------------------------------------------------------------
(async () => {
  const c = await getCfg();
  $('url').value = c.url || '';
  $('token').value = c.token || '';
})();
$('toggleCfg').addEventListener('click', (e) => {
  e.preventDefault();
  $('cfg').classList.toggle('hidden');
});
$('save').addEventListener('click', async () => {
  const url = $('url').value.trim();
  const token = $('token').value.trim();
  chrome.storage.local.set({ url, token });
  try {
    if (url) await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
  } catch {
    /* ignore */
  }
  setStatus('Réglages enregistrés.', 'ok');
});
