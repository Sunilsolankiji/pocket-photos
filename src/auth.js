'use strict';
const crypto = require('crypto');
const { normIp, isPrivate } = require('./net');
const { normFolder } = require('./library');

const SESSION_DAYS = 90;
const COOKIE = 'pp_session';
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const WINDOW = 15 * 60000;
const MAX_PER_IP = 10;
const MAX_REMOTE_TOTAL = 60;

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(pw, rec) {
  if (!rec) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(rec.salt, 'hex'), 64);
  const want = Buffer.from(rec.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));
const tokenKey = (t) => crypto.createHash('sha256').update(t).digest('hex');
const randomFrom = (chars, n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');

/** ~95 bits of entropy, easy to read aloud / type on a phone: "Ab3d-Ef5h-Jk7m-Np9q". */
function generatePassword() {
  return [0, 1, 2, 3].map(() => randomFrom(PW_CHARS, 4)).join('-');
}

function generateId() {
  return 'user-' + randomFrom(ID_CHARS, 6);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* malformed cookie */
      }
    }
  }
  return out;
}

class Auth {
  constructor(store, { uploadDir = 'Users' } = {}) {
    this.store = store;
    this.uploadDir = normFolder(uploadDir);
    this.fails = new Map();
    this.remoteFails = [];
    this.failLog = [];
    const d = store.data;
    d.users = d.users || {};
    d.sessions = d.sessions || {};
    // Migrate the old single-password setup to a user called "owner" who owns the whole drive.
    if (d.auth && d.auth.hash && !Object.keys(d.users).length) {
      d.users.owner = { id: 'owner', salt: d.auth.salt, hash: d.auth.hash, created: Date.now(), folders: [''] };
      for (const s of Object.values(d.sessions)) s.user = 'owner';
      for (const a of Object.values(d.albums || {})) if (!a.owner) a.owner = 'owner';
      console.log('[auth] migrated the existing password to user "owner"');
    }
    delete d.auth;
    for (const [k, s] of Object.entries(d.sessions)) if (!s.user || !d.users[s.user]) delete d.sessions[k];
    store.save();
  }

  get users() {
    return this.store.data.users;
  }

  get hasUsers() {
    return Object.keys(this.users).length > 0;
  }

  /** The personal upload folder every user always owns. */
  homeFolder(id) {
    return [this.uploadDir, id].filter(Boolean).join('/');
  }

  /** { folder: userId } for every user: their home folder plus folders assigned by the admin. */
  folderMap() {
    const map = {};
    for (const u of Object.values(this.users)) {
      for (const f of u.folders || []) map[f] = u.id;
      map[this.homeFolder(u.id)] = u.id;
    }
    return map;
  }

  setFolders(id, folders) {
    const u = this.users[id];
    if (!u) throw httpError(404, 'User not found');
    if (!Array.isArray(folders)) throw httpError(400, 'folders must be a list');
    const clean = [...new Set(folders.map((f) => normFolder(f)))];
    const taken = this.folderMap();
    for (const f of clean) {
      const other = taken[f] !== undefined ? taken[f] : Object.entries(taken).find(([k]) => k.toLowerCase() === f.toLowerCase())?.[1];
      if (other && other !== id) throw httpError(409, `Folder "${f || '(whole drive)'}" already belongs to ${other}`);
    }
    u.folders = clean.filter((f) => f !== this.homeFolder(id));
    this.store.save();
    return u.folders;
  }

  // ----- user management (admin) -----
  createUser({ id, password } = {}) {
    id = String(id || '').trim().toLowerCase();
    if (!id) {
      do id = generateId(); while (this.users[id]);
    }
    if (!ID_RE.test(id)) throw httpError(400, 'User ID must be 3-32 characters: letters, digits, dot, dash or underscore');
    if (this.users[id]) throw httpError(409, `User "${id}" already exists`);
    const holder = this.folderMap()[this.homeFolder(id)];
    if (holder) throw httpError(409, `Folder "${this.homeFolder(id)}" is already assigned to ${holder}`);
    const generated = !password;
    password = generated ? generatePassword() : String(password);
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    this.users[id] = { id, ...hashPassword(password), created: Date.now(), folders: [] };
    this.store.save();
    return { id, password, generated };
  }

  resetPassword(id, password) {
    const u = this.users[id];
    if (!u) throw httpError(404, 'User not found');
    const generated = !password;
    password = generated ? generatePassword() : String(password);
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    Object.assign(u, hashPassword(password), { changed: Date.now() });
    this.revokeUser(id);
    return { id, password, generated };
  }

  deleteUser(id) {
    if (!this.users[id]) throw httpError(404, 'User not found');
    delete this.users[id];
    this.revokeUser(id);
  }

  revokeUser(id, exceptKey) {
    let n = 0;
    for (const [k, s] of Object.entries(this.store.data.sessions)) {
      if (s.user === id && k !== exceptKey) {
        delete this.store.data.sessions[k];
        n++;
      }
    }
    this.store.save();
    return n;
  }

  revokeSession(key) {
    if (!this.store.data.sessions[key]) throw httpError(404, 'Session not found');
    delete this.store.data.sessions[key];
    this.store.save();
  }

  listUsers() {
    const now = Date.now();
    const sessions = Object.entries(this.store.data.sessions).filter(([, s]) => s.expires > now);
    return Object.values(this.users).map((u) => ({
      id: u.id, created: u.created, changed: u.changed || null, lastLogin: u.lastLogin || null,
      home: this.homeFolder(u.id), folders: u.folders || [],
      sessions: sessions.filter(([, s]) => s.user === u.id).map(([k, s]) => ({
        key: k.slice(0, 16), created: s.created, lastSeen: s.lastSeen || s.created, ip: s.ip || '', ua: s.ua || '',
      })),
    }));
  }

  findSessionKey(prefix) {
    return Object.keys(this.store.data.sessions).find((k) => k.startsWith(prefix) && prefix.length >= 16) || null;
  }

  // ----- login -----
  /** Returns the user id on success, null on failure. Always does the same amount of hashing work. */
  check(id, pw) {
    const u = this.users[String(id || '').trim().toLowerCase()];
    const ok = verifyPassword(String(pw || ''), u || DUMMY);
    return ok && u ? u.id : null;
  }

  changeOwnPassword(req, current, password) {
    const s = this.session(req);
    if (!s) throw httpError(401, 'Login required');
    if (!this.check(s.user, current)) throw httpError(401, 'Current password is wrong');
    if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    Object.assign(this.users[s.user], hashPassword(password), { changed: Date.now() });
    this.revokeUser(s.user, s.key);
  }

  createSession(userId, req) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.store.data.sessions[tokenKey(token)] = {
      user: userId, created: now, lastSeen: now, expires: now + SESSION_DAYS * 86400000,
      ua: String(req.headers['user-agent'] || '').slice(0, 200), ip: normIp(req.socket.remoteAddress),
    };
    this.users[userId].lastLogin = now;
    this.store.save();
    return token;
  }

  cookieFor(token, secure) {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure) {
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  tokenFrom(req) {
    return parseCookies(req.headers.cookie)[COOKIE] || null;
  }

  /** Returns { key, user } for a valid session, else null. */
  session(req) {
    const t = this.tokenFrom(req);
    if (!t) return null;
    const key = tokenKey(t);
    const s = this.store.data.sessions[key];
    if (!s) return null;
    const now = Date.now();
    if (s.expires < now || !this.users[s.user]) {
      delete this.store.data.sessions[key];
      this.store.save();
      return null;
    }
    if (now - (s.lastSeen || 0) > 3600000) {
      s.lastSeen = now;
      s.ip = normIp(req.socket.remoteAddress);
      this.store.save();
    }
    return { key, user: s.user };
  }

  isValid(req) {
    return !!this.session(req);
  }

  destroy(req) {
    const t = this.tokenFrom(req);
    if (t) {
      delete this.store.data.sessions[tokenKey(t)];
      this.store.save();
    }
  }

  // ----- brute-force protection -----
  /**
   * Max 10 failures per IP per 15 min. Additionally, internet (non-LAN) clients share a budget of
   * 60 failures per 15 min, which stops attacks spread over many IPs without locking out home devices.
   */
  limited(ip) {
    ip = normIp(ip);
    const now = Date.now();
    const f = this.fails.get(ip);
    if (f && now - f.first > WINDOW) this.fails.delete(ip);
    else if (f && f.count >= MAX_PER_IP) return true;
    if (!isPrivate(ip)) {
      this.remoteFails = this.remoteFails.filter((t) => now - t < WINDOW);
      if (this.remoteFails.length >= MAX_REMOTE_TOTAL) return true;
    }
    return false;
  }

  fail(ip, user) {
    ip = normIp(ip);
    const now = Date.now();
    const f = this.fails.get(ip);
    if (!f || now - f.first > WINDOW) this.fails.set(ip, { first: now, count: 1 });
    else f.count++;
    if (!isPrivate(ip)) this.remoteFails.push(now);
    this.failLog.unshift({ time: now, ip, user: String(user || '').slice(0, 40) });
    this.failLog.length = Math.min(this.failLog.length, 50);
  }

  succeed(ip) {
    this.fails.delete(normIp(ip));
  }
}

module.exports = { Auth, hashPassword, verifyPassword, parseCookies, generatePassword, generateId, ID_RE };
