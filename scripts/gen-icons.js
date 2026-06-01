'use strict';

/**
 * Génère les icônes PWA (192 et 512 px) sans aucune dépendance externe.
 * On dessine un fond plein + un glyphe "télécharger" blanc, puis on encode
 * un PNG RGBA à la main (zlib est fourni par Node).
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// --- Encodeur PNG -----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtre "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Dessin -----------------------------------------------------------------
function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  };

  // Fond : dégradé vertical indigo -> violet.
  for (let y = 0; y < size; y++) {
    const t = y / size;
    const r = Math.round(91 + (124 - 91) * t); // 5b -> 7c
    const g = Math.round(140 + (58 - 140) * t); // 8c -> 3a
    const b = Math.round(255 + (214 - 255) * t); // ff -> d6
    for (let x = 0; x < size; x++) set(x, y, r, g, b, 255);
  }

  const fillRect = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) set(x, y, 255, 255, 255, 255);
  };

  const S = size;
  // Hampe de la flèche.
  fillRect(0.44 * S, 0.24 * S, 0.56 * S, 0.56 * S);
  // Pointe (triangle vers le bas).
  const apexY = 0.72 * S;
  const topY = 0.5 * S;
  const leftX = 0.33 * S;
  const rightX = 0.67 * S;
  const apexX = 0.5 * S;
  for (let y = Math.round(topY); y < Math.round(apexY); y++) {
    const tt = (y - topY) / (apexY - topY);
    const lx = leftX + (apexX - leftX) * tt;
    const rx = rightX + (apexX - rightX) * tt;
    for (let x = Math.round(lx); x < Math.round(rx); x++) set(x, y, 255, 255, 255, 255);
  }
  // Bac (base horizontale).
  fillRect(0.28 * S, 0.78 * S, 0.72 * S, 0.84 * S);

  return encodePNG(size, size, buf);
}

// --- Écriture ---------------------------------------------------------------
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = makeIcon(size);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`icon-${size}.png (${png.length} octets)`);
}
console.log('Icônes générées dans public/icons/.');
