'use strict';

/**
 * Client du navigateur distant intégré.
 * Deux modes :
 *  - SD : frames JPEG (screencast) dessinées sur un <canvas> — léger.
 *  - HD : flux H.264/AAC (ffmpeg) lu par MediaSource dans une <video> — fluide + SON.
 * Entrées (souris/tactile/clavier) communes, en fractions [0..1], routées vers
 * la connexion active. Bouton ⬇ télécharge la page (URL + cookies de session).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $('bvCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const video = $('bvVideo');
  const statusEl = $('bvStatus');
  const urlInput = $('bvUrl');
  const form = $('bvForm');
  const torRow = $('bvTorRow');
  const torToggle = $('bvTor');
  const qualitySel = $('bvQuality');
  const keys = $('bvKeys');
  const kbBtn = $('bvKeyboard');
  const newIpBtn = $('bvNewIp');
  const hdBtn = $('bvHd');
  const stage = canvas.parentElement;

  let mode = 'sd'; // 'sd' (canvas/JPEG) ou 'hd' (video/MSE)
  let ws = null; // socket SD
  let hdWs = null; // socket HD
  let connected = false;
  let started = false;
  let leaving = false;
  let pingTimer = null;
  let flashTimer = null;
  let decoding = false;
  // MSE (mode HD)
  let mediaSource = null;
  let sourceBuffer = null;
  let bufQueue = [];

  const activeMedia = () => (mode === 'hd' ? video : canvas);
  const activeSock = () => (mode === 'hd' ? hdWs : ws);

  function setStatus(text, show = true) {
    statusEl.textContent = text || '';
    statusEl.style.display = show && text ? '' : 'none';
  }
  function flash(text) {
    setStatus(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => started && setStatus('', false), 3500);
  }

  function torParam() {
    return torToggle && torToggle.checked ? '1' : '0';
  }
  function sdUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    return `${proto}://${location.host}/ws/browser?tor=${torParam()}&dpr=${dpr}`;
  }
  function hdUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/hd?tor=${torParam()}`;
  }
  function viewportSize() {
    const r = stage.getBoundingClientRect();
    return {
      w: Math.max(320, Math.min(1600, Math.round(r.width) || 1024)),
      h: Math.max(240, Math.min(1000, Math.round(r.height) || 640)),
    };
  }
  function send(obj) {
    const s = activeSock();
    if (s && s.readyState === 1) s.send(JSON.stringify(obj));
  }
  function sendResize() {
    if (mode !== 'sd') return; // HD est en résolution fixe
    const { w, h } = viewportSize();
    send({ type: 'resize', width: w, height: h });
  }
  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send({ type: 'ping' }), 50000);
  }
  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  // --- Messages de contrôle (communs SD/HD) ----------------------------------
  function handleControl(msg) {
    if (msg.type === 'url') {
      if (document.activeElement !== urlInput) {
        urlInput.value = msg.url && msg.url !== 'about:blank' ? msg.url : '';
      }
    } else if (msg.type === 'ready') {
      if (newIpBtn) newIpBtn.classList.toggle('hidden', !msg.canNewIp);
    } else if (msg.type === 'newip') {
      flash('Nouvelle IP Tor obtenue 🔄');
    } else if (msg.type === 'download-started') {
      if (window.DownLL && window.DownLL.trackDownloadJob) {
        window.DownLL.trackDownloadJob(msg.jobId, msg.url);
      }
    } else if (msg.type === 'error') {
      flash(msg.message);
    }
  }

  // --- Mode SD (canvas / JPEG) ------------------------------------------------
  function connectSd() {
    if (ws) return;
    started = false;
    setStatus('Démarrage du navigateur…');
    let sock;
    try {
      sock = new WebSocket(sdUrl());
    } catch {
      setStatus('WebSocket indisponible.');
      return;
    }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      if (ws !== sock) return;
      connected = true;
      sendResize();
      send({ type: 'quality', level: qualitySel ? qualitySel.value : 'auto' });
      startPing();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      if (typeof ev.data !== 'string') drawJpeg(ev.data);
      else {
        try {
          handleControl(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      }
    };
    sock.onerror = () => {
      if (ws === sock) setStatus('Connexion impossible (occupé ou non autorisé).');
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      connected = false;
      stopPing();
      ws = null;
      if (!leaving && mode === 'sd') setStatus('Déconnecté — reviens sur l’onglet Navigateur.');
    };
  }
  function disconnectSd() {
    if (ws) {
      const s = ws;
      ws = null;
      try {
        s.onclose = null;
        s.onerror = null;
        s.close();
      } catch {
        /* ignore */
      }
    }
    stopPing();
  }
  async function drawJpeg(data) {
    if (decoding) return;
    decoding = true;
    try {
      const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      if (!started) {
        started = true;
        setStatus('', false);
      }
    } catch {
      /* frame ignorée */
    } finally {
      decoding = false;
    }
  }

  // --- Mode HD (video / MSE : H.264 + AAC) ------------------------------------
  function connectHd() {
    if (hdWs) return;
    started = false;
    setStatus('Démarrage HD (son)…');
    bufQueue = [];
    sourceBuffer = null;
    try {
      mediaSource = new MediaSource();
      video.src = URL.createObjectURL(mediaSource);
      mediaSource.addEventListener('sourceopen', () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', pumpBuf);
        } catch (e) {
          setStatus('Lecture HD non supportée : ' + e.message);
        }
      });
    } catch (e) {
      setStatus('MediaSource indisponible : ' + e.message);
      return;
    }
    let sock;
    try {
      sock = new WebSocket(hdUrl());
    } catch {
      setStatus('WebSocket HD indisponible.');
      return;
    }
    hdWs = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      if (hdWs !== sock) return;
      connected = true;
      startPing();
    };
    sock.onmessage = (ev) => {
      if (hdWs !== sock) return;
      if (typeof ev.data !== 'string') {
        appendChunk(ev.data);
        if (!started) {
          started = true;
          setStatus('', false);
          video.play().catch(() => {});
        }
      } else {
        try {
          handleControl(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      }
    };
    sock.onerror = () => {
      if (hdWs === sock) setStatus('Connexion HD impossible (occupé ou non autorisé).');
    };
    sock.onclose = () => {
      if (hdWs !== sock) return;
      connected = false;
      stopPing();
      hdWs = null;
      if (!leaving && mode === 'hd') setStatus('HD déconnecté.');
    };
  }
  function disconnectHd() {
    if (hdWs) {
      const s = hdWs;
      hdWs = null;
      try {
        s.onclose = null;
        s.onerror = null;
        s.close();
      } catch {
        /* ignore */
      }
    }
    stopPing();
    try {
      video.pause();
      video.playbackRate = 1;
      video.removeAttribute('src');
      video.load();
    } catch {
      /* ignore */
    }
    mediaSource = null;
    sourceBuffer = null;
    bufQueue = [];
  }
  function appendChunk(buf) {
    bufQueue.push(new Uint8Array(buf));
    pumpBuf();
  }
  function pumpBuf() {
    if (sourceBuffer && !sourceBuffer.updating && bufQueue.length) {
      try {
        sourceBuffer.appendBuffer(bufQueue.shift());
      } catch {
        trimBuffer();
      }
    }
    syncLive();
  }
  // Garde la lecture collée au direct (faible latence) : resync dur si trop en
  // retard, sinon léger rattrapage par la vitesse de lecture.
  function syncLive() {
    if (!video.buffered.length) return;
    let live;
    try {
      live = video.buffered.end(video.buffered.length - 1);
    } catch {
      return;
    }
    const delay = live - video.currentTime;
    // Hystérésis : on ne rattrape (pitch audio légèrement modifié) qu'au-delà de
    // 0,5 s, et on s'arrête sous 0,3 s. Resync dur si vraiment en retard.
    if (delay > 0.9 || delay < 0) {
      try {
        video.currentTime = live - 0.12;
      } catch {
        /* ignore */
      }
      video.playbackRate = 1.0;
    } else if (delay > 0.5) {
      video.playbackRate = 1.05;
    } else if (delay < 0.3) {
      video.playbackRate = 1.0;
    }
    trimBuffer();
  }
  function trimBuffer() {
    try {
      if (sourceBuffer && !sourceBuffer.updating && video.buffered.length) {
        const start = video.buffered.start(0);
        if (video.currentTime - start > 3) sourceBuffer.remove(0, video.currentTime - 2);
      }
    } catch {
      /* ignore */
    }
  }

  // --- Bascule de mode --------------------------------------------------------
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    const last = urlInput.value.trim();
    if (hdBtn) hdBtn.classList.toggle('active', m === 'hd');
    if (qualitySel) qualitySel.classList.toggle('hidden', m === 'hd');
    if (m === 'hd') {
      disconnectSd();
      canvas.classList.add('hidden');
      video.classList.remove('hidden');
      connectHd();
    } else {
      disconnectHd();
      video.classList.add('hidden');
      canvas.classList.remove('hidden');
      connectSd();
    }
    // re-navigue vers la page courante une fois reconnecté
    const renav = () => {
      const s = activeSock();
      if (s && s.readyState === 1) {
        if (last) send({ type: 'navigate', url: last });
      } else if (!leaving) setTimeout(renav, 150);
    };
    setTimeout(renav, m === 'hd' ? 400 : 250);
  }
  function reconnectActive() {
    const last = urlInput.value.trim();
    if (mode === 'hd') {
      disconnectHd();
      connectHd();
    } else {
      disconnectSd();
      connectSd();
    }
    const renav = () => {
      const s = activeSock();
      if (s && s.readyState === 1) {
        if (last) send({ type: 'navigate', url: last });
      } else if (!leaving) setTimeout(renav, 150);
    };
    setTimeout(renav, mode === 'hd' ? 400 : 250);
  }

  // --- Barre d'outils ---------------------------------------------------------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = urlInput.value.trim();
    if (!u) return;
    if (mode === 'hd') connectHd();
    else connectSd();
    send({ type: 'navigate', url: u });
    urlInput.blur();
  });
  $('bvBack').addEventListener('click', () => send({ type: 'back' }));
  $('bvForward').addEventListener('click', () => send({ type: 'forward' }));
  $('bvReload').addEventListener('click', () => send({ type: 'reload' }));
  $('bvDownload').addEventListener('click', () => {
    send({ type: 'download' });
    flash('Téléchargement demandé…');
  });
  if (newIpBtn) {
    newIpBtn.addEventListener('click', () => {
      send({ type: 'newip' });
      flash('Nouvelle IP Tor en cours…');
    });
  }
  if (qualitySel) {
    qualitySel.addEventListener('change', () => send({ type: 'quality', level: qualitySel.value }));
  }
  if (hdBtn) {
    hdBtn.addEventListener('click', () => setMode(mode === 'hd' ? 'sd' : 'hd'));
  }
  if (torToggle) {
    torToggle.addEventListener('change', reconnectActive);
  }

  // --- Clavier (champ caché : clavier mobile + IME) ---------------------------
  function focusKeys() {
    try {
      keys.focus({ preventScroll: true });
    } catch {
      keys.focus();
    }
  }
  const SPECIAL = new Set([
    'Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End',
    'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ]);
  let composing = false;
  keys.addEventListener('compositionstart', () => (composing = true));
  keys.addEventListener('compositionend', (e) => {
    composing = false;
    if (e.data) send({ type: 'text', text: e.data });
    keys.value = '';
  });
  keys.addEventListener('input', (e) => {
    if (composing) return;
    const t = e.inputType;
    if (t === 'insertText' && e.data) send({ type: 'text', text: e.data });
    else if (t === 'insertLineBreak' || t === 'insertParagraph') send({ type: 'key', key: 'Enter' });
    else if (t === 'deleteContentBackward') send({ type: 'key', key: 'Backspace' });
    else if (t === 'deleteContentForward') send({ type: 'key', key: 'Delete' });
    keys.value = '';
  });
  keys.addEventListener('keydown', (e) => {
    if (SPECIAL.has(e.key)) {
      e.preventDefault();
      send({ type: 'key', key: e.key });
    }
  });
  if (kbBtn) {
    kbBtn.addEventListener('click', () => {
      if (document.activeElement === keys) keys.blur();
      else focusKeys();
    });
  }

  // --- Entrées (souris + tactile) attachées au "stage", mappées sur le média --
  function toFrac(clientX, clientY) {
    const r = activeMedia().getBoundingClientRect();
    return {
      fx: Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1))),
      fy: Math.min(1, Math.max(0, (clientY - r.top) / (r.height || 1))),
    };
  }
  const btnName = (b) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');
  stage.addEventListener('mousedown', (e) => {
    e.preventDefault();
    focusKeys();
    const p = toFrac(e.clientX, e.clientY);
    send({ type: 'mouse', action: 'down', fx: p.fx, fy: p.fy, button: btnName(e.button) });
  });
  stage.addEventListener('mouseup', (e) => {
    const p = toFrac(e.clientX, e.clientY);
    send({ type: 'mouse', action: 'up', fx: p.fx, fy: p.fy, button: btnName(e.button) });
  });
  let lastMove = 0;
  stage.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 30) return;
    lastMove = now;
    const p = toFrac(e.clientX, e.clientY);
    send({ type: 'mouse', action: 'move', fx: p.fx, fy: p.fy });
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      send({ type: 'wheel', dx: e.deltaX, dy: e.deltaY });
    },
    { passive: false }
  );
  function touchPoints(list) {
    const r = activeMedia().getBoundingClientRect();
    const arr = [];
    for (const t of list) {
      arr.push({
        fx: Math.min(1, Math.max(0, (t.clientX - r.left) / (r.width || 1))),
        fy: Math.min(1, Math.max(0, (t.clientY - r.top) / (r.height || 1))),
        id: t.identifier,
      });
    }
    return arr;
  }
  stage.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      send({ type: 'touch', phase: 'start', points: touchPoints(e.touches) });
    },
    { passive: false }
  );
  stage.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      send({ type: 'touch', phase: 'move', points: touchPoints(e.touches) });
    },
    { passive: false }
  );
  stage.addEventListener(
    'touchend',
    (e) => {
      e.preventDefault();
      const remaining = touchPoints(e.touches);
      send({ type: 'touch', phase: remaining.length ? 'move' : 'end', points: remaining });
    },
    { passive: false }
  );
  stage.addEventListener('touchcancel', () => send({ type: 'touch', phase: 'cancel', points: [] }));

  // --- Redimensionnement (SD) -------------------------------------------------
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => connected && sendResize(), 250);
  });

  // Maintien du direct en HD même sans nouvelle frame (resync régulier).
  if (video) video.addEventListener('timeupdate', syncLive);

  // --- Cycle de vie -----------------------------------------------------------
  document.addEventListener('downll:view', (e) => {
    if (e.detail.view === 'browser') {
      leaving = false;
      if (mode === 'hd') connectHd();
      else {
        connectSd();
        setTimeout(() => connected && sendResize(), 120);
      }
    }
  });
  document.addEventListener('downll:caps', (e) => {
    if (e.detail && e.detail.proxy) torRow.classList.remove('hidden');
    if (e.detail && e.detail.hd && hdBtn) hdBtn.classList.remove('hidden');
  });
  window.addEventListener('beforeunload', () => {
    leaving = true;
    disconnectSd();
    disconnectHd();
  });
})();
