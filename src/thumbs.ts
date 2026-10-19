'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Queue, run } = require('./proc');

const ORIENT_FILTER = {
  2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2',
};

/** Generates and caches JPEG thumbnails/previews with ffmpeg. */
class Thumbs {
  [key: string]: any;

  constructor(cfg, tools) {
    this.cfg = cfg;
    this.tools = tools;
    this.queue = new Queue(cfg.workers);
    this.pending = new Map();
    this.failed = new Set();
  }

  file(kind, id) {
    return path.join(this.cfg.dataDir, kind === 'thumb' ? 'thumbs' : 'previews', id.slice(0, 2), id + '.jpg');
  }

  async exists(kind, id) {
    try {
      await fsp.access(this.file(kind, id));
      return true;
    } catch {
      return false;
    }
  }

  /** Returns path to a cached JPEG, generating it if needed; null when not possible. */
  async get(kind, item, abs, priority = 'high') {
    const out = this.file(kind, item.id);
    if (await this.exists(kind, item.id)) return out;
    if (!this.tools.ffmpeg) return null;
    const key = kind + ':' + item.id;
    if (this.failed.has(key)) return null;
    if (!this.pending.has(key)) {
      const p = this.queue
        .run(() => this._generate(kind, item, abs, out), priority)
        .then(() => out)
        .catch((e) => {
          this.failed.add(key);
          console.warn(`[thumbs] ${kind} failed for ${item.path}: ${e.message.split('\n')[0]}`);
          return null;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return this.pending.get(key);
  }

  async _generate(kind, item, abs, out) {
    if (await this.exists(kind, item.id)) return;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`;
    const S = kind === 'thumb' ? this.cfg.thumbSize : this.cfg.previewSize;
    const scale = kind === 'thumb'
      ? `scale=${S}:${S}:force_original_aspect_ratio=increase,crop=${S}:${S}`
      : `scale=w='min(${S},iw)':h='min(${S},ih)':force_original_aspect_ratio=decrease`;
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (item.type === 'video') {
      const ss = item.dur ? Math.min(1, item.dur / 2) : 0;
      args.push('-ss', String(ss), '-i', abs);
      args.push('-vf', scale);
    } else {
      args.push('-noautorotate', '-i', abs);
      const o = ORIENT_FILTER[item.orient];
      args.push('-vf', (o ? o + ',' : '') + scale);
    }
    args.push('-frames:v', '1', '-q:v', kind === 'thumb' ? '5' : '3', tmp);
    try {
      await run(this.tools.ffmpeg, args, { timeout: 180000 });
      await fsp.rename(tmp, out);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async remove(id) {
    this.failed.delete('thumb:' + id);
    this.failed.delete('preview:' + id);
    await Promise.all(['thumb', 'preview'].map((k) => fsp.unlink(this.file(k, id)).catch(() => {})));
  }
}

module.exports = { Thumbs };
