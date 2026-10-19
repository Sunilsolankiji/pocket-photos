'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { mediaType, extractMeta } = require('./meta');

const SKIP_DIRS = new Set(['system volume information', '$recycle.bin', 'lost.dir', 'android', 'node_modules']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const idFor = (rel) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);

function safeName(name) {
  let n = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  n = n.replace(/^\.+/, '');
  if (!n) n = 'file';
  if (n.length > 150) {
    const ext = path.extname(n).slice(0, 10);
    n = n.slice(0, 150 - ext.length) + ext;
  }
  return n;
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const p = path.join(dir, i ? `${base} (${i})${ext}` : name);
    try {
      await fsp.access(p);
    } catch {
      return p;
    }
  }
  throw new Error('Could not find a free filename');
}

async function moveFile(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

async function* walk(dir, skip) {
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (!isDir && !isFile) {
      // Some Android/FUSE filesystems don't report dirent types; fall back to stat.
      try {
        const s = await fsp.stat(p);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      if (SKIP_DIRS.has(e.name.toLowerCase()) || skip(p)) continue;
      yield* walk(p, skip);
    } else if (isFile) {
      yield p;
    }
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v) => (typeof v === 'string' ? v.slice(0, 80) : '');
const isId = (id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);

function slim(i) {
  return {
    id: i.id, name: i.name, type: i.type, taken: num(i.taken), w: num(i.w), h: num(i.h),
    dur: num(i.dur), fav: !!i.fav, trashed: num(i.trashed), size: num(i.size),
    v: Math.floor(i.mtime / 1000).toString(36),
  };
}

const searchCache = new WeakMap();
function searchText(i) {
  let s = searchCache.get(i);
  if (s !== undefined) return s;
  const d = new Date(i.taken);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  s = `${i.path} ${i.make || ''} ${i.model || ''} ${ymd} ${MONTHS[d.getMonth()]} ${i.type === 'video' ? 'video' : 'photo'}`.toLowerCase();
  searchCache.set(i, s);
  return s;
}

class Library {
  constructor(cfg, store, thumbs, tools) {
    this.cfg = cfg;
    this.store = store;
    this.thumbs = thumbs;
    this.tools = tools;
    this.readOnly = false;
    this.sorted = null;
    this.userLists = new Map();
    this.owners = [];
    this.scanning = null;
    this.scanState = { running: false, started: 0, finished: 0, found: 0, added: 0, updated: 0, removed: 0, error: null };
    this.warming = false;
  }

  get items() {
    return this.store.data.items;
  }
  get albums() {
    return this.store.data.albums;
  }

  changed() {
    this.sorted = null;
    this.userLists.clear();
    this.store.save();
  }

  /** Item flags/albums changed but not the set of items: keep the sorted caches (they hold the same objects). */
  touched() {
    this.store.save();
  }

  // ---------- ownership ----------

  /** folders: { "DCIM": "alice", "Users/bob": "bob", "": "owner" } – the longest matching folder wins. */
  setOwners(folders) {
    this.owners = Object.entries(folders)
      .map(([f, u]) => [normFolder(f).toLowerCase(), u])
      .sort((a, b) => b[0].length - a[0].length);
    this.userLists.clear();
  }

  ownerOf(rel) {
    const p = String(rel).toLowerCase();
    for (const [f, u] of this.owners) if (f === '' || p === f || p.startsWith(f + '/')) return u;
    return null;
  }

  owns(user, item) {
    return !!user && !!item && this.ownerOf(item.path) === user;
  }

  userList(user) {
    let l = this.userLists.get(user);
    if (!l) {
      l = this.sortedList().filter((i) => this.ownerOf(i.path) === user);
      this.userLists.set(user, l);
    }
    return l;
  }

  albumFor(id, user) {
    const a = typeof id === 'string' && Object.hasOwn(this.albums, id) ? this.albums[id] : undefined;
    if (!a || a.owner !== user) throw new HttpError(404, 'Album not found');
    return a;
  }

  abs(item) {
    return path.join(this.cfg.mediaDir, ...item.path.split('/'));
  }

  rel(abs) {
    return path.relative(this.cfg.mediaDir, abs).split(path.sep).join('/');
  }

  /** Own, well-formed item ids only. */
  item(id) {
    return isId(id) && Object.hasOwn(this.items, id) ? this.items[id] : undefined;
  }

  get(id, user) {
    const it = this.item(id);
    if (!it || (user !== undefined && !this.owns(user, it))) throw new HttpError(404, 'Not found');
    return it;
  }

  makeItem(rel, stat, meta, type) {
    const item = {
      id: idFor(rel), path: rel, name: path.posix.basename(rel), type,
      size: stat.size, mtime: Math.round(stat.mtimeMs), taken: meta.taken,
    };
    if (num(meta.width) && num(meta.height)) {
      item.w = Math.round(meta.width);
      item.h = Math.round(meta.height);
    }
    if (num(meta.duration)) item.dur = meta.duration;
    if (Number.isInteger(meta.orientation) && meta.orientation > 1 && meta.orientation <= 8) item.orient = meta.orientation;
    if (str(meta.make)) item.make = str(meta.make);
    if (str(meta.model)) item.model = str(meta.model);
    return item;
  }

  sortedList() {
    if (!this.sorted) {
      this.sorted = Object.values(this.items).sort((a, b) => b.taken - a.taken || (a.path < b.path ? 1 : -1));
    }
    return this.sorted;
  }

  query({ user, view = 'all', album = '', q = '', offset = 0, limit = 200 } = {}) {
    let list = this.userList(user);
    if (view === 'trash') {
      list = list.filter((i) => i.trashed);
    } else {
      list = list.filter((i) => !i.trashed);
      if (view === 'favorites') list = list.filter((i) => i.fav);
      else if (view === 'videos') list = list.filter((i) => i.type === 'video');
      else if (view === 'photos') list = list.filter((i) => i.type === 'image');
      else if (view === 'album') {
        const a = this.albumFor(album, user);
        const set = new Set(a.items);
        list = list.filter((i) => set.has(i.id));
      }
    }
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) list = list.filter((i) => { const s = searchText(i); return terms.every((t) => s.includes(t)); });
    offset = Math.max(0, offset | 0);
    limit = Math.min(1000, Math.max(1, limit | 0));
    return { total: list.length, items: list.slice(offset, offset + limit).map(slim) };
  }

  /** Per-user stats when `user` is given, whole-library stats (plus unassigned count) otherwise. */
  stats(user) {
    let photos = 0, videos = 0, bytes = 0, trashed = 0, favorites = 0, unassigned = 0;
    const list = user === undefined ? Object.values(this.items) : this.userList(user);
    for (const i of list) {
      if (i.trashed) trashed++;
      else if (i.type === 'video') videos++;
      else photos++;
      if (i.fav) favorites++;
      bytes += i.size || 0;
      if (user === undefined && this.ownerOf(i.path) === null) unassigned++;
    }
    const albums = Object.values(this.albums).filter((a) => user === undefined || a.owner === user).length;
    return { photos, videos, trashed, favorites, bytes, albums, ...(user === undefined ? { unassigned } : {}) };
  }

  /** Folders (up to 2 levels deep) that contain media, with item counts and current owner. For the admin page. */
  folderSummary() {
    const counts = new Map();
    for (const i of Object.values(this.items)) {
      const parts = i.path.split('/').slice(0, -1);
      for (let d = 1; d <= Math.min(2, parts.length); d++) {
        const f = parts.slice(0, d).join('/');
        counts.set(f, (counts.get(f) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([folder, count]) => ({ folder, count, owner: this.ownerOf(folder + '/x') }));
  }

  // ---------- scanning ----------

  scan() {
    if (!this.scanning) {
      this.scanning = this._scan().finally(() => {
        this.scanning = null;
        if (this.cfg.pregenerate) this.warmThumbs();
      });
    }
    return this.scanning;
  }

  async _scan() {
    const st = this.scanState;
    Object.assign(st, { running: true, started: Date.now(), finished: 0, found: 0, added: 0, updated: 0, removed: 0, error: null });
    const scanStart = st.started;
    const dataDir = path.resolve(this.cfg.dataDir);
    const skip = (p) => path.resolve(p) === dataDir;
    try {
      await fsp.access(this.cfg.mediaDir);
      const seen = new Set();
      for await (const abs of walk(this.cfg.mediaDir, skip)) {
        const type = mediaType(abs);
        if (!type) continue;
        let s;
        try {
          s = await fsp.stat(abs);
        } catch {
          continue;
        }
        const rel = this.rel(abs);
        const id = idFor(rel);
        seen.add(id);
        st.found++;
        const ex = this.items[id];
        if (ex && ex.size === s.size && Math.floor(ex.mtime / 1000) === Math.floor(s.mtimeMs / 1000)) continue;
        const meta = await extractMeta(abs, type, s, path.basename(abs), this.tools);
        const item = this.makeItem(rel, s, meta, type);
        if (ex) {
          item.fav = ex.fav;
          item.trashed = ex.trashed;
          item.added = ex.added;
          await this.thumbs.remove(id);
          st.updated++;
        } else {
          item.added = Date.now();
          st.added++;
        }
        this.items[id] = item;
        if ((st.added + st.updated) % 250 === 0) this.changed();
      }
      const known = Object.keys(this.items).length;
      if (seen.size === 0 && known > 0) {
        st.error = 'No media found - is the drive mounted? Skipped removing missing items.';
      } else {
        for (const [id, it] of Object.entries(this.items)) {
          if (!seen.has(id) && (it.added || 0) < scanStart) {
            await this.removeEntry(id);
            st.removed++;
          }
        }
      }
    } catch (e) {
      st.error = e.message;
    } finally {
      st.running = false;
      st.finished = Date.now();
      this.changed();
    }
    return st;
  }

  async warmThumbs() {
    if (this.warming || !this.tools.ffmpeg) return;
    this.warming = true;
    try {
      for (const it of this.sortedList().slice()) {
        if (this.scanning) break;
        if (!this.items[it.id]) continue;
        if (await this.thumbs.exists('thumb', it.id)) continue;
        await this.thumbs.get('thumb', it, this.abs(it), 'low');
      }
    } finally {
      this.warming = false;
    }
  }

  // ---------- uploads ----------

  findDuplicate(user, hash, name, size) {
    for (const i of this.userList(user)) {
      if ((hash && i.hash === hash) || (i.name === name && i.size === size)) return i;
    }
    return null;
  }

  async ingest(stream, rawName, mtime, user) {
    if (this.readOnly) throw new HttpError(403, 'Library is read-only (media folder not writable)');
    if (!user) throw new HttpError(401, 'Login required');
    const name = safeName(rawName);
    const type = mediaType(name);
    if (!type) throw new HttpError(415, 'Unsupported file type');
    const tmpDir = path.join(this.cfg.dataDir, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, crypto.randomBytes(8).toString('hex') + path.extname(name).toLowerCase());
    const hasher = crypto.createHash('sha1');
    let size = 0;
    const max = this.cfg.maxUploadBytes;
    try {
      await pipeline(
        stream,
        new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > max) return cb(new HttpError(413, 'File too large'));
            hasher.update(chunk);
            cb(null, chunk);
          },
        }),
        fs.createWriteStream(tmp),
      );
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    const hash = hasher.digest('hex');
    try {
      if (size === 0) throw new HttpError(400, 'Empty file');
      const dup = this.findDuplicate(user, hash, name, size);
      if (dup) {
        await fsp.unlink(tmp).catch(() => {});
        return { duplicate: true, item: slim(dup) };
      }
      const when = Number.isFinite(mtime) && mtime > 0 ? mtime : Date.now();
      const meta = await extractMeta(tmp, type, { mtimeMs: when, size }, name, this.tools);
      const d = new Date(meta.taken);
      const dir = path.join(this.userDir(user), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
      await fsp.mkdir(dir, { recursive: true });
      const dest = await uniquePath(dir, name);
      await moveFile(tmp, dest);
      try {
        await fsp.utimes(dest, new Date(), new Date(when));
      } catch {
        /* some filesystems refuse utimes */
      }
      const s = await fsp.stat(dest);
      const item = this.makeItem(this.rel(dest), s, meta, type);
      item.hash = hash;
      item.added = Date.now();
      this.items[item.id] = item;
      this.changed();
      if (this.tools.ffmpeg) this.thumbs.get('thumb', item, dest, 'low');
      return { duplicate: false, item: slim(item) };
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // ---------- mutations ----------

  /** Absolute path of a user's personal upload folder: <media>/<uploadDir>/<user>. */
  userDir(user) {
    return path.join(this.cfg.mediaDir, ...normFolder(this.cfg.uploadDir).split('/').filter(Boolean), user);
  }

  async removeEntry(id) {
    delete this.items[id];
    for (const a of Object.values(this.albums)) {
      const idx = a.items.indexOf(id);
      if (idx >= 0) a.items.splice(idx, 1);
      if (a.cover === id) a.cover = null;
    }
    await this.thumbs.remove(id);
  }

  async deleteForever(ids) {
    if (this.readOnly) throw new HttpError(403, 'Library is read-only');
    let n = 0;
    for (const id of ids) {
      const it = this.items[id];
      if (!it) continue;
      try {
        await fsp.unlink(this.abs(it));
      } catch (e) {
        if (e.code !== 'ENOENT') throw new HttpError(500, `Could not delete ${it.path}: ${e.code || e.message}`);
      }
      await this.removeEntry(id);
      n++;
    }
    this.changed();
    return n;
  }

  async batch(ids, action, opts = {}, user) {
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be an array');
    ids = [...new Set(ids)].filter((id) => this.item(id) && (user === undefined || this.owns(user, this.items[id])));
    const now = Date.now();
    switch (action) {
      case 'favorite':
      case 'unfavorite':
        for (const id of ids) this.items[id].fav = action === 'favorite';
        break;
      case 'trash':
        if (this.readOnly) throw new HttpError(403, 'Library is read-only');
        for (const id of ids) this.items[id].trashed = now;
        break;
      case 'restore':
        for (const id of ids) delete this.items[id].trashed;
        break;
      case 'delete':
        return { count: await this.deleteForever(ids.filter((id) => this.items[id].trashed)) };
      case 'addToAlbum':
      case 'removeFromAlbum': {
        const a = user === undefined ? this.albumFor(opts.album, this.albums[opts.album] && this.albums[opts.album].owner) : this.albumFor(opts.album, user);
        if (action === 'addToAlbum') {
          const set = new Set(a.items);
          for (const id of ids) if (!set.has(id)) a.items.push(id);
        } else {
          const rm = new Set(ids);
          a.items = a.items.filter((id) => !rm.has(id));
          if (rm.has(a.cover)) a.cover = null;
        }
        a.updated = now;
        break;
      }
      default:
        throw new HttpError(400, 'Unknown action');
    }
    this.touched();
    return { count: ids.length };
  }

  async purgeTrash() {
    const cutoff = Date.now() - this.cfg.trashDays * 86400000;
    const old = Object.values(this.items).filter((i) => num(i.trashed) && i.trashed < cutoff).map((i) => i.id);
    if (old.length && !this.readOnly) await this.deleteForever(old);
    return old.length;
  }

  // ---------- albums (each album belongs to one user) ----------

  listAlbums(user) {
    return Object.values(this.albums)
      .filter((a) => a.owner === user)
      .map((a) => {
        const live = a.items.filter((id) => this.items[id] && !this.items[id].trashed && this.owns(user, this.items[id]));
        let cover = a.cover && this.items[a.cover] && this.owns(user, this.items[a.cover]) ? this.items[a.cover] : null;
        if (!cover && live.length) {
          cover = live.map((id) => this.items[id]).sort((x, y) => y.taken - x.taken)[0];
        }
        return { id: a.id, name: a.name, count: live.length, created: a.created, updated: a.updated, cover: cover ? slim(cover) : null };
      })
      .sort((x, y) => (y.updated || y.created) - (x.updated || x.created));
  }

  createAlbum(name, ids = [], user) {
    name = String(name || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Album name required');
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.albums[id] = { id, owner: user, name, created: now, updated: now, cover: null, items: [...new Set(ids)].filter((i) => this.owns(user, this.item(i))) };
    this.touched();
    return this.albums[id];
  }

  updateAlbum(id, { name, cover }, user) {
    const a = this.albumFor(id, user);
    if (name !== undefined) {
      name = String(name).trim().slice(0, 120);
      if (!name) throw new HttpError(400, 'Album name required');
      a.name = name;
    }
    if (cover !== undefined) a.cover = cover && this.owns(user, this.item(cover)) ? cover : null;
    a.updated = Date.now();
    this.touched();
    return a;
  }

  deleteAlbum(id, user) {
    this.albumFor(id, user);
    delete this.albums[id];
    this.touched();
  }

  deleteUserAlbums(user) {
    for (const [id, a] of Object.entries(this.albums)) if (a.owner === user) delete this.albums[id];
    this.touched();
  }
}

/** "/DCIM\\Camera/" -> "DCIM/Camera"; rejects "..". Empty string means the whole drive. */
function normFolder(f) {
  const parts = String(f || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new HttpError(400, 'Folder may not contain ".."');
  return parts.join('/');
}

module.exports = { Library, HttpError, safeName, idFor, slim, walk, normFolder };
