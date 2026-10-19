'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Store } = require('./store');
const { Thumbs } = require('./thumbs');
const { Library, HttpError, slim } = require('./library');
const { Auth, AdminAuth } = require('./auth');
const { readProfile, cleanUpdate } = require('./profile');
const { isLocalRequest, isPrivate } = require('./net');
const { ensureCert, readCert, describeCert, DuckDns, publicIp } = require('./remote');
const { hasTool } = require('./proc');
const { mimeOf, isWebImage } = require('./meta');
const { Router, authorizeRoute } = require('./router');
const { ROOT } = require('./config');
const { version } = require(path.join(ROOT, 'package.json'));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

async function isWritable(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const f = path.join(dir, `.pp-write-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    await fsp.writeFile(f, 'x');
    await fsp.unlink(f);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readJson(req, limit = 1024 * 1024, deadline = 30000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => {
      reject(new HttpError(408, 'Request body took too long'));
      req.destroy();
    }, deadline);
    req.on('close', () => clearTimeout(timer));
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        clearTimeout(timer);
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (!chunks.length) return resolve({});
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new HttpError(400, 'Invalid JSON'));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'Expected a JSON object'));
      resolve(body);
    });
    req.on('error', reject);
  });
}

async function sendFile(req, res, file, { mime, downloadName, maxAge = 0 }: { mime?: string; downloadName?: string; maxAge?: number } = {}) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'File missing on disk');
  }
  const size = st.size;
  const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    'Cache-Control': maxAge ? `private, max-age=${maxAge}` : 'private, no-cache',
  };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, headers);
    return res.end();
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && (m[1] || m[2]) && size > 0) {
    if (m[1] === '') start = Math.max(0, size - parseInt(m[2], 10));
    else {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const s = fs.createReadStream(file, { start, end });
  s.on('error', () => res.destroy());
  res.on('close', () => s.destroy());
  s.pipe(res);
}

function lanAddresses() {
  try {
    const out = [];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const list = interfaces[name];
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
  } catch {
    // Android blocks interface enumeration for apps (uv_interface_addresses EACCES).
    return [];
  }
}

/** Where data goes when <mediaDir>/.pocketphotos is not writable (e.g. read-only SSD). */
function fallbackDataDir(cfg) {
  return path.join(os.homedir(), '.pocketphotos-data', crypto.createHash('sha1').update(cfg.mediaDir).digest('hex').slice(0, 8));
}

async function createApp(cfg) {
  if (!(await isWritable(cfg.mediaDir))) {
    try {
      await fsp.access(cfg.mediaDir);
    } catch {
      throw new Error(`Media folder does not exist or is not readable: ${cfg.mediaDir}`);
    }
  }
  const mediaWritable = await isWritable(cfg.mediaDir);
  if (!(await isWritable(cfg.dataDir))) {
    const fallback = fallbackDataDir(cfg);
    console.warn(`[pocketphotos] data folder ${cfg.dataDir} not writable, using ${fallback}`);
    cfg.dataDir = fallback;
    await fsp.mkdir(cfg.dataDir, { recursive: true });
  }
  cfg.tlsCert = path.resolve(cfg.tlsCert || path.join(cfg.dataDir, 'tls', 'cert.pem'));
  cfg.tlsKey = path.resolve(cfg.tlsKey || path.join(cfg.dataDir, 'tls', 'key.pem'));

  const tools = {
    ffmpeg: (await hasTool(cfg.ffmpeg)) ? cfg.ffmpeg : null,
    ffprobe: (await hasTool(cfg.ffprobe)) ? cfg.ffprobe : null,
  };
  const store = new Store(path.join(cfg.dataDir, 'db.json'));
  store.load();
  const thumbs = new Thumbs(cfg, tools);
  const lib = new Library(cfg, store, thumbs, tools);
  lib.readOnly = !mediaWritable;
  const auth = new Auth(store, { uploadDir: cfg.uploadDir });
  const adminAuth = new AdminAuth(store);
  const syncOwners = () => lib.setOwners(auth.folderMap());
  syncOwners();
  const makeHome = async (id) => {
    if (lib.readOnly) return;
    await fsp.mkdir(lib.userDir(id), { recursive: true }).catch(() => {});
  };
  store.data.settings = store.data.settings || {};
  const settings = () => {
    const s = store.data.settings;
    const get = (k) => (s[k] !== undefined ? s[k] : cfg[k]) || '';
    return { duckdnsDomain: get('duckdnsDomain'), duckdnsToken: get('duckdnsToken'), publicHost: get('publicHost') };
  };
  const publicHostName = () => {
    const s = settings();
    return s.publicHost || (s.duckdnsDomain ? `${s.duckdnsDomain.replace(/\.duckdns\.org$/i, '')}.duckdns.org` : '');
  };
  const duck = new DuckDns(settings);
  const tls = { enabled: false, server: null, address: null, mtime: 0, info: null, error: null };

  const router = new Router();
  // access: 'open' (no login), 'user' (valid session), 'local' (only from the phone itself),
  // 'admin' (from the phone itself AND signed in with the admin password)
  const route = (method, pattern, handler, access = 'user') => router.add(method, pattern, handler, access);
  const secure = (req) => !!req.socket.encrypted;

  // ----- profile (each user sees and edits only their own) -----
  const avatarOk = (user, id) => {
    try {
      const it = lib.get(id, user);
      return it.type === 'image' && !it.trashed;
    } catch {
      return false;
    }
  };
  const profileOf = (id) => {
    const u = auth.users[id];
    const p = readProfile(u);
    const avatar = p.avatar && avatarOk(id, p.avatar) ? { id: p.avatar, v: slim(lib.get(p.avatar)).v } : null;
    return { id, created: u.created, ...p, avatar };
  };

  // ----- auth -----
  route('GET', '/api/status', async (req, res) => {
    const s = auth.session(req);
    sendJson(res, 200, {
      version, hasUsers: auth.hasUsers, authed: !!s, user: s ? s.user : null, local: isLocalRequest(req),
      profile: s ? profileOf(s.user) : null,
      readOnly: lib.readOnly, ffmpeg: !!tools.ffmpeg, ffprobe: !!tools.ffprobe, trashDays: cfg.trashDays,
    });
  }, 'open');

  route('POST', '/api/login', async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (auth.limited(ip)) throw new HttpError(429, 'Too many failed attempts, try again in 15 minutes');
    const { user, password } = await readJson(req);
    const id = auth.check(user, password);
    if (!id) {
      auth.fail(ip, user);
      throw new HttpError(401, 'Wrong user ID or password');
    }
    auth.succeed(ip);
    const token = auth.createSession(id, req);
    sendJson(res, 200, { ok: true, user: id }, { 'Set-Cookie': auth.cookieFor(token, secure(req)) });
  }, 'open');

  route('POST', '/api/logout', async (req, res) => {
    auth.destroy(req);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(secure(req)) });
  }, 'open');

  route('POST', '/api/password', async (req, res) => {
    const { current, password } = await readJson(req);
    auth.changeOwnPassword(req, current, password);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/profile', async (req, res) => sendJson(res, 200, profileOf(req.user)));
  route('PATCH', '/api/profile', async (req, res) => {
    const update = cleanUpdate(await readJson(req, 16 * 1024), (id) => avatarOk(req.user, id));
    const u = auth.users[req.user];
    u.profile = { ...readProfile(u), ...update };
    store.save();
    sendJson(res, 200, profileOf(req.user));
  });

  // ----- admin sign-in (phone only; the admin password protects everything below) -----
  const adminState = () => ({ passwordSet: adminAuth.isSet, lockedMinutes: adminAuth.lockedFor() });
  route('GET', '/api/admin/auth', async (req, res) => sendJson(res, 200, { ...adminState(), authed: adminAuth.valid(req) }), 'local');

  route('POST', '/api/admin/setup', async (req, res) => {
    const { password } = await readJson(req);
    adminAuth.setup(password);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': adminAuth.cookieFor(adminAuth.login(password)) });
  }, 'local');

  route('POST', '/api/admin/login', async (req, res) => {
    const { password } = await readJson(req);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': adminAuth.cookieFor(adminAuth.login(password)) });
  }, 'local');

  route('POST', '/api/admin/logout', async (req, res) => {
    adminAuth.logout(req);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': adminAuth.clearCookie() });
  }, 'local');

  route('POST', '/api/admin/password', async (req, res) => {
    const { current, password } = await readJson(req);
    adminAuth.change(current, password);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': adminAuth.cookieFor(adminAuth.login(password)) });
  }, 'admin');

  // ----- admin (only reachable from the phone itself: http://localhost:<port>/admin) -----
  route('GET', '/api/admin/overview', async (req, res) => {
    const s = settings();
    const users = auth.listUsers().map((u) => ({ ...u, stats: lib.stats(u.id) }));
    sendJson(res, 200, {
      users,
      library: { ...lib.stats(), mediaDir: cfg.mediaDir, uploadDir: cfg.uploadDir, readOnly: lib.readOnly, scan: lib.scanState },
      folders: lib.folderSummary(),
      failedLogins: auth.failLog,
      remote: {
        httpPort: server.address() && server.address().port,
        httpsPort: tls.address ? tls.address.port : null,
        httpsEnabled: tls.enabled, httpsError: tls.error, cert: tls.info, certFile: cfg.tlsCert,
        allowRemoteHttp: cfg.allowRemoteHttp, lanIps: lanAddresses(), publicIp: await publicIp(),
        publicHost: publicHostName(), settings: { duckdnsDomain: s.duckdnsDomain, duckdnsTokenSet: !!s.duckdnsToken, publicHost: s.publicHost },
        duckdns: duck.status,
      },
    });
  }, 'admin');

  route('POST', '/api/admin/users', async (req, res) => {
    const { id, password, folders } = await readJson(req);
    const created = auth.createUser({ id, password });
    try {
      if (Array.isArray(folders) && folders.length) auth.setFolders(created.id, folders);
    } catch (e) {
      auth.deleteUser(created.id);
      throw e;
    }
    syncOwners();
    await makeHome(created.id);
    sendJson(res, 200, created);
  }, 'admin');

  route('PUT', '/api/admin/users/:id/folders', async (req, res, p) => {
    const { folders } = await readJson(req);
    const result = auth.setFolders(p.id, folders);
    syncOwners();
    sendJson(res, 200, { folders: result });
  }, 'admin');

  route('POST', '/api/admin/users/:id/reset', async (req, res, p) => {
    const { password } = await readJson(req);
    sendJson(res, 200, auth.resetPassword(p.id, password));
  }, 'admin');

  route('POST', '/api/admin/users/:id/signout', async (req, res, p) => {
    if (!auth.users[p.id]) throw new HttpError(404, 'User not found');
    sendJson(res, 200, { revoked: auth.revokeUser(p.id) });
  }, 'admin');

  route('DELETE', '/api/admin/users/:id', async (req, res, p) => {
    auth.deleteUser(p.id);
    lib.deleteUserAlbums(p.id);
    syncOwners();
    sendJson(res, 200, { ok: true });
  }, 'admin');

  route('POST', '/api/admin/scan', async (req, res) => {
    lib.scan();
    sendJson(res, 202, lib.scanState);
  }, 'admin');

  route('DELETE', '/api/admin/sessions/:key', async (req, res, p) => {
    const key = auth.findSessionKey(p.key);
    if (!key) throw new HttpError(404, 'Session not found');
    auth.revokeSession(key);
    sendJson(res, 200, { ok: true });
  }, 'admin');

  route('PUT', '/api/admin/settings', async (req, res) => {
    const body = await readJson(req);
    const s = store.data.settings;
    if (body.duckdnsDomain !== undefined) {
      const d = String(body.duckdnsDomain).trim().toLowerCase().replace(/\.duckdns\.org$/, '');
      if (d && !/^[a-z0-9-]{1,63}$/.test(d)) throw new HttpError(400, 'DuckDNS domain should look like "myphotos" (from myphotos.duckdns.org)');
      s.duckdnsDomain = d;
    }
    if (body.duckdnsToken !== undefined && body.duckdnsToken !== '') {
      const t = String(body.duckdnsToken).trim();
      if (!/^[a-f0-9-]{36}$/i.test(t)) throw new HttpError(400, 'DuckDNS token should be a 36-character code from duckdns.org');
      s.duckdnsToken = t;
    }
    if (body.clearDuckdnsToken) s.duckdnsToken = '';
    if (body.publicHost !== undefined) {
      const h = String(body.publicHost).trim().toLowerCase();
      if (h && !/^[a-z0-9.-]{1,253}$/.test(h)) throw new HttpError(400, 'Invalid host name');
      s.publicHost = h;
    }
    store.save();
    duck.start();
    sendJson(res, 200, { ok: true, status: await duck.update() });
  }, 'admin');

  route('POST', '/api/admin/duckdns/update', async (req, res) => sendJson(res, 200, await duck.update()), 'admin');

  route('POST', '/api/admin/tls/regenerate', async (req, res) => {
    if (tls.info && !tls.info.selfSigned) throw new HttpError(409, 'A real (CA-signed) certificate is installed; replace its files instead');
    await fsp.rm(cfg.tlsCert, { force: true });
    await fsp.rm(cfg.tlsKey, { force: true });
    await setupTls();
    if (!tls.enabled) throw new HttpError(500, tls.error || 'Could not create certificate');
    sendJson(res, 200, { ok: true, cert: tls.info });
  }, 'admin');

  // ----- media (every route is scoped to the signed-in user's own photos & videos) -----
  route('GET', '/api/media', async (req, res, p, url) => {
    const s = url.searchParams;
    sendJson(res, 200, lib.query({
      user: req.user, view: s.get('view') || 'all', album: s.get('album') || '', q: s.get('q') || '',
      offset: Number(s.get('offset') || 0), limit: Number(s.get('limit') || 200),
    }));
  });

  route('GET', '/api/media/:id', async (req, res, p) => {
    const it = lib.get(p.id, req.user);
    const albums = (Object.values(lib.albums) as Record<string, any>[]).filter((a) => a.owner === req.user && a.items.includes(it.id)).map((a) => ({ id: a.id, name: a.name }));
    sendJson(res, 200, { ...slim(it), path: it.path, make: it.make || null, model: it.model || null, mtime: it.mtime, added: it.added || null, albums });
  });

  route('GET', '/api/media/:id/thumb', async (req, res, p) => {
    const it = lib.get(p.id, req.user);
    const f = await thumbs.get('thumb', it, lib.abs(it));
    if (f) return sendFile(req, res, f, { mime: 'image/jpeg', maxAge: 30 * 86400 });
    if (it.type === 'image' && isWebImage(it.name)) return sendFile(req, res, lib.abs(it), { mime: mimeOf(it.name), maxAge: 86400 });
    throw new HttpError(404, 'No thumbnail');
  });

  route('GET', '/api/media/:id/preview', async (req, res, p) => {
    const it = lib.get(p.id, req.user);
    if (it.type === 'video' || isWebImage(it.name)) return sendFile(req, res, lib.abs(it), { mime: mimeOf(it.name), maxAge: 86400 });
    const f = await thumbs.get('preview', it, lib.abs(it));
    if (f) return sendFile(req, res, f, { mime: 'image/jpeg', maxAge: 30 * 86400 });
    return sendFile(req, res, lib.abs(it), { mime: mimeOf(it.name) });
  });

  route('GET', '/api/media/:id/original', async (req, res, p, url) => {
    const it = lib.get(p.id, req.user);
    const dl = url.searchParams.get('download') ? it.name : undefined;
    return sendFile(req, res, lib.abs(it), { mime: mimeOf(it.name), downloadName: dl, maxAge: 86400 });
  });

  route('PATCH', '/api/media/:id', async (req, res, p) => {
    const it = lib.get(p.id, req.user);
    const body = await readJson(req);
    if (body.fav !== undefined) await lib.batch([it.id], body.fav ? 'favorite' : 'unfavorite', {}, req.user);
    sendJson(res, 200, slim(it));
  });

  route('POST', '/api/media/batch', async (req, res) => {
    const { ids, action, album } = await readJson(req);
    sendJson(res, 200, await lib.batch(ids, action, { album }, req.user));
  });

  route('POST', '/api/trash/empty', async (req, res) => {
    const ids = lib.userList(req.user).filter((i) => i.trashed).map((i) => i.id);
    sendJson(res, 200, { count: await lib.deleteForever(ids) });
  });

  route('PUT', '/api/upload', async (req, res, p, url) => {
    const name = url.searchParams.get('name');
    if (!name) throw new HttpError(400, 'name required');
    const declared = Number(req.headers['content-length']);
    if (declared > cfg.maxUploadBytes) throw new HttpError(413, 'File too large');
    if (declared) {
      let free = Infinity;
      try {
        const s = await fsp.statfs(cfg.mediaDir);
        free = s.bavail * s.bsize;
      } catch {
        /* statfs unsupported */
      }
      if (free < declared + 50 * 1024 * 1024) throw new HttpError(507, 'Not enough free space on drive');
    }
    const result = await lib.ingest(req, name, Number(url.searchParams.get('mtime')), req.user);
    sendJson(res, 200, result);
  });

  // ----- albums (private to their owner) -----
  route('GET', '/api/albums', async (req, res) => sendJson(res, 200, { albums: lib.listAlbums(req.user) }));
  route('POST', '/api/albums', async (req, res) => {
    const { name, ids } = await readJson(req);
    const a = lib.createAlbum(name, Array.isArray(ids) ? ids : [], req.user);
    sendJson(res, 200, { id: a.id, name: a.name, count: a.items.length });
  });
  route('GET', '/api/albums/:id', async (req, res, p) => {
    const a = lib.albumFor(p.id, req.user);
    sendJson(res, 200, { id: a.id, name: a.name, created: a.created, cover: a.cover });
  });
  route('PATCH', '/api/albums/:id', async (req, res, p) => {
    const a = lib.updateAlbum(p.id, await readJson(req), req.user);
    sendJson(res, 200, { id: a.id, name: a.name });
  });
  route('DELETE', '/api/albums/:id', async (req, res, p) => {
    lib.deleteAlbum(p.id, req.user);
    sendJson(res, 200, { ok: true });
  });

  // ----- library -----
  // Scanning reports whole-drive numbers, so it is admin-only.
  route('POST', '/api/scan', async (req, res) => {
    lib.scan();
    sendJson(res, 202, lib.scanState);
  }, 'local');
  route('GET', '/api/scan', async (req, res) => sendJson(res, 200, lib.scanState), 'local');
  route('GET', '/api/stats', async (req, res) => {
    let disk = null;
    try {
      const s = await fsp.statfs(cfg.mediaDir);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      /* statfs unsupported */
    }
    const local = isLocalRequest(req);
    sendJson(res, 200, {
      ...lib.stats(req.user), disk, readOnly: lib.readOnly, ffmpeg: !!tools.ffmpeg, ffprobe: !!tools.ffprobe,
      queue: thumbs.queue.size, version, local,
      ...(local ? { mediaDir: cfg.mediaDir, dataDir: cfg.dataDir, scan: lib.scanState } : {}),
    });
  });

  // ----- static -----
  const ADMIN_FILES = new Set(['/admin', '/admin/', '/admin.html', '/admin.js']);
  async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (ADMIN_FILES.has(rel)) {
      if (!isLocalRequest(req)) {
        throw new HttpError(404, 'The admin page only opens on the phone running PocketPhotos: http://localhost:' + server.address().port + '/admin');
      }
      res.setHeader('Cache-Control', 'no-store');
      if (rel !== '/admin.js') rel = '/admin.html';
    } else if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel.replace(/\\/g, '/')));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
    const mime = STATIC_MIME[path.extname(file)] || 'application/octet-stream';
    return sendFile(req, res, file, { mime });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // No inline/third-party scripts anywhere, so injected markup cannot run code even if escaping is ever missed.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // Never accept plain-HTTP traffic from the internet: passwords and photos would travel unencrypted.
    if (!secure(req) && !cfg.allowRemoteHttp && !isPrivate(req.socket.remoteAddress)) {
      const host = publicHostName();
      const msg = tls.enabled && host ? `Use https://${host}${tls.address.port === 443 ? '' : ':' + tls.address.port}/` : 'Use the HTTPS address';
      throw new HttpError(403, `Plain HTTP is only allowed on the home network. ${msg}`);
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const found = router.match(method, url.pathname);
    if (!found) throw new HttpError(404, 'Not found');
    const { route: r, match: m } = found;
    authorizeRoute(req, method, r, { auth, adminAuth, isLocalRequest });
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return r.handler(req, res, params, url);
  }

  const listener = (req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status >= 500) console.error(`[http] ${req.method} ${req.url}:`, e.stack || e.message);
      if (res.headersSent) return res.destroy();
      if (req.readable && !req.readableEnded) req.resume();
      sendJson(res, status, { error: e.message || 'Server error' });
    });
  };
  const tune = (s) => {
    s.requestTimeout = 0; // allow long uploads over slow connections...
    s.timeout = 120000; // ...but drop sockets that send/receive nothing for 2 minutes (slow-drip / stalled clients)
    s.headersTimeout = 20000;
    s.keepAliveTimeout = 10000;
    s.maxHeadersCount = 100;
    s.maxConnections = 256;
    return s;
  };
  const server = tune(http.createServer(listener));

  async function setupTls() {
    tls.error = null;
    try {
      if (!(await ensureCert(cfg, [publicHostName(), ...lanAddresses()]))) {
        tls.error = `No certificate at ${cfg.tlsCert} and openssl is not installed (pkg install openssl-tool)`;
        return;
      }
      const c = await readCert(cfg);
      tls.mtime = c.mtime;
      tls.info = describeCert(c.cert);
      if (tls.server) {
        tls.server.setSecureContext({ cert: c.cert, key: c.key });
      } else {
        tls.server = tune(https.createServer({ cert: c.cert, key: c.key }, listener));
        await new Promise((resolve, reject) => {
          tls.server.once('error', reject);
          tls.server.listen(cfg.httpsPort, cfg.host, resolve);
        });
        tls.address = tls.server.address();
      }
      tls.enabled = true;
    } catch (e) {
      tls.error = e.message;
      console.error('[tls]', e.message);
      if (tls.server && !tls.server.listening) tls.server = null;
    }
  }

  // Pick up renewed certificates (e.g. from acme.sh / Let's Encrypt) without a restart.
  async function reloadCertIfChanged() {
    if (!tls.server) return;
    try {
      const st = await fsp.stat(cfg.tlsCert);
      if (st.mtimeMs !== tls.mtime) {
        await setupTls();
        console.log('[tls] certificate reloaded');
      }
    } catch {
      /* cert temporarily missing */
    }
  }

  const timers = [];
  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
    if (cfg.httpsPort > 0) {
      await setupTls();
      timers.push(setInterval(() => reloadCertIfChanged(), 3600000));
    }
    duck.start();
    lib.scan();
    if (cfg.rescanMinutes > 0) timers.push(setInterval(() => lib.scan(), cfg.rescanMinutes * 60000));
    timers.push(setInterval(() => lib.purgeTrash().catch((e) => console.error('[trash]', e.message)), 3600000));
    lib.purgeTrash().catch(() => {});
    return server.address();
  }

  async function close() {
    timers.forEach(clearInterval);
    duck.stop();
    const servers = [server, tls.server].filter((s) => s && s.listening);
    const closed = Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    for (const s of servers) if (s.closeAllConnections) s.closeAllConnections();
    await closed;
    if (lib.scanning) await lib.scanning.catch(() => {});
    await store.close();
  }

  return { server, tls, store, lib, auth, adminAuth, thumbs, tools, cfg, start, close, lanAddresses, publicHostName, reloadCertIfChanged };
}

module.exports = { createApp, lanAddresses, fallbackDataDir };
