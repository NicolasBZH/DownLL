'use strict';

/**
 * Authentification minimale par mot de passe partagé.
 *
 * - Activée seulement si AUTH_PASSWORD est définie (sinon app ouverte = comportement historique).
 * - Pas de base, pas de session serveur : un cookie HttpOnly signé HMAC suffit.
 */

const crypto = require('crypto');

const PASSWORD = process.env.AUTH_PASSWORD || '';
// Secret de signature : explicite, sinon dérivé du mot de passe (stable entre redémarrages).
const SECRET =
  process.env.AUTH_SECRET ||
  (PASSWORD ? crypto.createHash('sha256').update(`downll:${PASSWORD}`).digest('hex') : '');
const COOKIE = 'downll_auth';
const TTL_MS = parseInt(process.env.AUTH_TTL_MS || String(30 * 24 * 3600 * 1000), 10); // 30 j

const enabled = () => !!PASSWORD;

function sign(exp) {
  const mac = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return `${exp}.${mac}`;
}

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyToken(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return timingEqual(token, sign(exp));
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

/** Vérifie l'auth d'une requête HTTP (ou d'un upgrade WebSocket : même objet `req`). */
function isAuthed(req) {
  if (!enabled()) return true;
  return verifyToken(parseCookies(req.headers && req.headers.cookie)[COOKIE]);
}

function checkPassword(pw) {
  return enabled() && timingEqual(pw, PASSWORD);
}

function issueCookie(res) {
  const token = sign(Date.now() + TTL_MS);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`
  );
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { enabled, isAuthed, checkPassword, issueCookie, clearCookie };
