'use strict';
const path = require('path');
const { readImageInfo } = require('./exif');
const { run } = require('./proc');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.3gp', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.wmv']);
const WEB_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.wmv': 'video/x-ms-wmv',
};

function mediaType(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

const isWebImage = (name) => WEB_IMAGE_EXT.has(path.extname(name).toLowerCase());
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

/** Dates embedded in filenames, e.g. 20231015_123456.jpg, IMG-20231015-WA0001.jpg, Screenshot_2023-10-15-12-34-56. */
function dateFromName(name) {
  const m = /(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[ _\-T.]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d))?(?!\d)/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h = '12', mi = '00', s = '00'] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return t > Date.now() + 86400000 ? null : t;
}

async function ffprobe(bin, file) {
  const out = await run(bin, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60000 });
  const j = JSON.parse(out.toString('utf8'));
  const res: Record<string, any> = {};
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (v) {
    res.width = v.width;
    res.height = v.height;
    let rot = 0;
    if (v.tags && v.tags.rotate) rot = Number(v.tags.rotate);
    for (const sd of v.side_data_list || []) if (sd.rotation !== undefined) rot = Number(sd.rotation);
    if (Math.abs(rot) % 180 === 90) [res.width, res.height] = [res.height, res.width];
  }
  const dur = Number((j.format && j.format.duration) || (v && v.duration));
  if (dur > 0 && Number.isFinite(dur)) res.duration = Math.round(dur * 10) / 10;
  const tags = Object.assign({}, v && v.tags, j.format && j.format.tags);
  const ct = tags.creation_time || tags['com.apple.quicktime.creationdate'];
  if (ct) {
    const t = Date.parse(ct);
    // Some cameras write 1970/1904 epoch when the clock is unset.
    if (!Number.isNaN(t) && t > Date.UTC(1990, 0, 1)) res.taken = t;
  }
  const model = tags['com.android.model'] || tags['com.apple.quicktime.model'];
  const make = tags['com.android.manufacturer'] || tags['com.apple.quicktime.make'];
  if (model) res.model = model;
  if (make) res.make = make;
  return res;
}

/**
 * Collect metadata for a media file.
 * tools: { ffprobe: string|null }
 */
async function extractMeta(file, type, stat, name, tools: { ffprobe?: string | null } = {}) {
  const meta: Record<string, any> = {};
  if (type === 'image') {
    try {
      Object.assign(meta, (await readImageInfo(file)) || {});
    } catch {
      /* unreadable header */
    }
  }
  if (tools.ffprobe && (type === 'video' || !meta.width)) {
    try {
      const p = await ffprobe(tools.ffprobe, file);
      for (const [k, v] of Object.entries(p)) if (meta[k] === undefined) meta[k] = v;
    } catch {
      /* ffprobe failed: keep what we have */
    }
  }
  if (meta.orientation >= 5 && meta.width && meta.height && type === 'image') {
    [meta.width, meta.height] = [meta.height, meta.width];
  }
  meta.taken = meta.taken || dateFromName(name) || Math.round(stat.mtimeMs);
  return meta;
}

module.exports = { mediaType, isWebImage, mimeOf, extractMeta, dateFromName, ffprobe, IMAGE_EXT, VIDEO_EXT };
