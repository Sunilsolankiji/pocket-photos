'use strict';
const fs = require('fs');

async function readHead(file, n = 256 * 1024) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function parseTiff(t) {
  const res = {};
  if (t.length < 8) return res;
  const order = t.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return res;
  const le = order === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const readIfd = (off) => {
    const tags = {};
    if (!off || off + 2 > t.length) return tags;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const sz = (TYPE_SIZES[type] || 1) * count;
      const voff = sz <= 4 ? e + 8 : u32(e + 8);
      if (voff + sz > t.length) continue;
      let v = null;
      if (type === 2) v = t.toString('latin1', voff, voff + count).replace(/\0[\s\S]*$/, '').trim();
      else if (type === 3) v = u16(voff);
      else if (type === 4 || type === 9) v = u32(voff);
      else if (type === 5 || type === 10) v = u32(voff) / (u32(voff + 4) || 1);
      tags[tag] = v;
    }
    return tags;
  };
  try {
    const ifd0 = readIfd(u32(4));
    // Only trust tags with the expected TIFF type: crafted files can put text where numbers belong.
    const text = (v) => (typeof v === 'string' && v ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) : null);
    const int = (v, max) => (Number.isInteger(v) && v > 0 && v <= max ? v : null);
    if (text(ifd0[0x010f])) res.make = text(ifd0[0x010f]);
    if (text(ifd0[0x0110])) res.model = text(ifd0[0x0110]);
    if (int(ifd0[0x0112], 8)) res.orientation = ifd0[0x0112];
    let date = null;
    let offset = null;
    if (ifd0[0x8769]) {
      const ex = readIfd(ifd0[0x8769]);
      date = ex[0x9003] || ex[0x9004] || null;
      offset = ex[0x9011] || ex[0x9010] || null;
      if (int(ex[0xa002], 1e6) && int(ex[0xa003], 1e6)) {
        res.width = ex[0xa002];
        res.height = ex[0xa003];
      }
    }
    date = date || ifd0[0x0132];
    const taken = parseExifDate(date, offset);
    if (taken) res.taken = taken;
  } catch {
    /* malformed EXIF: ignore */
  }
  return res;
}

function parseExifDate(s, offset) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  if (+y < 1900 || +mo < 1 || +mo > 12 || +d < 1) return null;
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`);
    if (!Number.isNaN(t)) return t;
  }
  return new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime();
}

function isSof(m) {
  return (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf);
}

function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = {};
  let exifDone = false;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    const start = i + 4;
    const end = i + 2 + len;
    if (marker === 0xe1 && !exifDone && buf.toString('latin1', start, start + 6) === 'Exif\0\0') {
      Object.assign(out, parseTiff(buf.subarray(start + 6, Math.min(end, buf.length))));
      exifDone = true;
    } else if (isSof(marker) && start + 5 <= buf.length) {
      out.height = buf.readUInt16BE(start + 1);
      out.width = buf.readUInt16BE(start + 3);
    }
    i = end;
  }
  return out;
}

function parsePng(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function readImageInfo(file) {
  const buf = await readHead(file);
  return parseJpeg(buf) || parsePng(buf) || null;
}

module.exports = { readImageInfo, parseJpeg, parseTiff, parseExifDate, parsePng };
