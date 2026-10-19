'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const { parseJpeg, parseExifDate } = require('../src/exif');
const { dateFromName } = require('../src/meta');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { slim } = require('../src/library');

const FFMPEG = process.env.PP_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.PP_FFPROBE || 'ffprobe';
let hasFfmpeg = true;
try {
  execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

function buildExif({ make = 'samsung', orientation = 6, date = '2023:10:15 12:34:56', offset = '+03:00', exifExtra = [] } = {}) {
  const buf = Buffer.alloc(512);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  let data = 160;
  const putStr = (s) => { const off = data; buf.write(s + '\0', off, 'latin1'); data += s.length + 1; return off; };
  let p;
  const entry = (tag, type, count, v) => {
    buf.writeUInt16LE(tag, p); buf.writeUInt16LE(type, p + 2); buf.writeUInt32LE(count, p + 4);
    if (type === 3) buf.writeUInt16LE(v, p + 8); else buf.writeUInt32LE(v, p + 8);
    p += 12;
  };
  p = 8; buf.writeUInt16LE(3, p); p += 2;
  entry(0x010f, 2, make.length + 1, putStr(make));
  entry(0x0112, 3, 1, orientation);
  entry(0x8769, 4, 1, 50);
  buf.writeUInt32LE(0, p);
  p = 50; buf.writeUInt16LE(2 + exifExtra.length, p); p += 2;
  entry(0x9003, 2, date.length + 1, putStr(date));
  entry(0x9011, 2, offset.length + 1, putStr(offset));
  for (const [tag, v] of exifExtra) {
    if (typeof v === 'string') entry(tag, 2, v.length + 1, putStr(v));
    else entry(tag, 4, 1, v);
  }
  buf.writeUInt32LE(0, p);
  return buf.subarray(0, data);
}

function withExif(jpeg, exifOpts) {
  const tiff = buildExif(exifOpts);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, payload, jpeg.subarray(2)]);
}

// Minimal JPEG skeleton (SOI + SOF0 + EOI) – enough for header parsing.
function fakeJpeg(w, h) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

test('EXIF parser reads date, offset, camera, orientation and size', () => {
  const info = parseJpeg(withExif(fakeJpeg(4000, 3000)));
  assert.strictEqual(info.make, 'samsung');
  assert.strictEqual(info.orientation, 6);
  assert.strictEqual(info.width, 4000);
  assert.strictEqual(info.height, 3000);
  assert.strictEqual(info.taken, Date.parse('2023-10-15T12:34:56+03:00'));
});

test('EXIF tags with the wrong type are ignored (no text where numbers belong)', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const exif = withExif(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { make: 'cam\x01era', exifExtra: [[0xa002, xss], [0xa003, xss]] });
  // EXIF placed after the SOF so the real JPEG size cannot overwrite the bad values
  const info = parseJpeg(Buffer.concat([Buffer.from([0xff, 0xd8]), fakeJpeg(10, 10).subarray(2, 15), exif.subarray(2)]));
  assert.notStrictEqual(info.width, xss);
  assert.ok(info.width === undefined || typeof info.width === 'number');
  assert.strictEqual(info.make, 'camera');
  assert.deepStrictEqual(slim({ id: 'x', name: 'n', type: 'image', taken: 1, w: xss, h: '1', size: 5, mtime: 0 }).w, 0);
});

test('config rejects invalid numbers instead of silently ignoring them', () => {
  assert.throws(() => loadConfig({ mediaDir: os.tmpdir(), maxUploadBytes: 'lots' }), /maxUploadBytes/);
  assert.throws(() => loadConfig({ mediaDir: os.tmpdir(), port: 70000 }), /port/);
  assert.throws(() => loadConfig({ mediaDir: os.tmpdir(), port: 8080, httpsPort: 8080 }), /differ/);
  assert.strictEqual(loadConfig({ mediaDir: os.tmpdir(), trashDays: '7' }).trashDays, 7);
});

test('EXIF date without offset is local time; invalid dates rejected', () => {
  assert.strictEqual(parseExifDate('2020:01:02 03:04:05'), new Date(2020, 0, 2, 3, 4, 5).getTime());
  assert.strictEqual(parseExifDate('0000:00:00 00:00:00'), null);
  assert.strictEqual(parseExifDate(''), null);
});

test('dates are extracted from common Android filenames', () => {
  assert.strictEqual(dateFromName('20231015_123456.jpg'), new Date(2023, 9, 15, 12, 34, 56).getTime());
  assert.strictEqual(dateFromName('IMG-20220101-WA0003.jpg'), new Date(2022, 0, 1, 12).getTime());
  assert.strictEqual(dateFromName('Screenshot_20240229-081500_Chrome.png'), new Date(2024, 1, 29, 8, 15, 0).getTime());
  assert.strictEqual(dateFromName('holiday.jpg'), null);
});

// ---------------- integration ----------------

let adminCookie = null;
function request(base, method, url, { body, headers = {}, cookie, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, base);
    const h = { ...headers };
    if (!cookie && adminCookie && u.pathname.startsWith('/api/admin/')) cookie = adminCookie;
    // Browsers always send Origin on writes; pass Origin: null to simulate a client that omits it.
    if (method !== 'GET' && h.Origin === undefined) h.Origin = new URL(base).origin;
    if (h.Origin === null) delete h.Origin;
    if (cookie) h.Cookie = cookie;
    let data = body;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      data = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
    }
    if (data) h['Content-Length'] = data.length;
    const req = http.request({ host: u.hostname, port: u.port, path: raw || u.pathname + u.search, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if ((res.headers['content-type'] || '').includes('json')) json = JSON.parse(buf.toString());
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('full server flow', { timeout: 120000 }, async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pp-test-'));
  const media = path.join(tmp, 'ssd');
  await fsp.mkdir(path.join(media, 'DCIM', 'Camera'), { recursive: true });
  await fsp.mkdir(path.join(media, '.hidden'), { recursive: true });

  let photo;
  if (hasFfmpeg) {
    const src = path.join(tmp, 'src.jpg');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', '-y', src]);
    photo = withExif(fs.readFileSync(src));
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-pix_fmt', 'yuv420p',
      '-metadata', 'creation_time=2022-05-01T10:00:00Z', '-y', path.join(media, 'DCIM', 'Camera', 'clip.mp4')]);
  } else {
    photo = withExif(fakeJpeg(640, 480));
    fs.writeFileSync(path.join(media, 'DCIM', 'Camera', 'clip.mp4'), Buffer.alloc(4096, 1));
  }
  fs.writeFileSync(path.join(media, 'DCIM', 'Camera', 'photo.jpg'), photo);
  fs.writeFileSync(path.join(media, '.hidden', 'skip.jpg'), photo);
  fs.writeFileSync(path.join(media, 'notes.txt'), 'not media');

  const cfg = loadConfig({ mediaDir: media, port: 0, host: '127.0.0.1', httpsPort: 0, ffmpeg: FFMPEG, ffprobe: FFPROBE, rescanMinutes: 0, pregenerate: false });
  const app = await createApp(cfg);
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  await app.lib.scan();
  const remoteHost = { Host: 'photos.example.com' };

  // admin is only reachable from the phone itself
  let r = await request(base, 'GET', '/api/status');
  assert.strictEqual(r.json.hasUsers, false);
  assert.strictEqual(r.json.authed, false);
  assert.strictEqual(r.json.local, true);
  r = await request(base, 'GET', '/api/status', { headers: remoteHost });
  assert.strictEqual(r.json.local, false);
  r = await request(base, 'GET', '/api/media');
  assert.strictEqual(r.status, 401);
  r = await request(base, 'GET', '/admin');
  assert.strictEqual(r.status, 200);
  assert.match(r.buf.toString(), /PocketPhotos Admin/);
  r = await request(base, 'GET', '/admin', { headers: remoteHost });
  assert.strictEqual(r.status, 404, 'admin page hidden from non-local hosts (DNS rebinding)');
  r = await request(base, 'GET', '/admin.js', { headers: remoteHost });
  assert.strictEqual(r.status, 404);
  r = await request(base, 'GET', '/api/admin/overview', { headers: remoteHost });
  assert.strictEqual(r.status, 403);
  r = await request(base, 'POST', '/api/admin/users', { headers: { Host: 'evil.com' }, body: { id: 'hacker' } });
  assert.strictEqual(r.status, 403);
  r = await request(base, 'POST', '/api/admin/users', { headers: { Origin: 'http://evil.com' }, body: { id: 'hacker' } });
  assert.strictEqual(r.status, 403, 'cross-origin admin requests blocked');
  r = await request(base, 'POST', '/api/admin/users', { headers: { Origin: null }, body: { id: 'hacker' } });
  assert.strictEqual(r.status, 403, 'admin writes need an Origin header');
  r = await request(base, 'GET', '/');
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);

  // admin password: required even on the phone itself
  r = await request(base, 'GET', '/api/admin/overview');
  assert.strictEqual(r.status, 401, 'admin API needs the admin password');
  r = await request(base, 'POST', '/api/admin/users', { body: { id: 'sneaky' } });
  assert.strictEqual(r.status, 401);
  r = await request(base, 'GET', '/api/admin/auth');
  assert.deepStrictEqual(r.json, { passwordSet: false, lockedMinutes: 0, authed: false });
  r = await request(base, 'GET', '/api/admin/auth', { headers: remoteHost });
  assert.strictEqual(r.status, 403, 'admin sign-in is phone-only too');
  r = await request(base, 'POST', '/api/admin/setup', { body: { password: '123' } });
  assert.strictEqual(r.status, 400, 'admin password min length');
  r = await request(base, 'POST', '/api/admin/setup', { body: { password: '246810' } });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  r = await request(base, 'POST', '/api/admin/setup', { body: { password: 'takeover' } });
  assert.strictEqual(r.status, 409, 'setup only works once');
  assert.ok(!JSON.stringify(app.store.data.admin).includes('246810'), 'admin password stored hashed');
  r = await request(base, 'POST', '/api/admin/login', { body: { password: 'wrong-pin' } });
  assert.strictEqual(r.status, 401);
  r = await request(base, 'POST', '/api/admin/login', { body: { password: '246810' } });
  assert.strictEqual(r.status, 200);
  adminCookie = r.headers['set-cookie'][0].split(';')[0];
  r = await request(base, 'GET', '/api/admin/overview', { headers: remoteHost });
  assert.strictEqual(r.status, 403, 'admin cookie does not help from other devices');

  // create users from the admin API
  r = await request(base, 'POST', '/api/admin/users', { body: { id: 'Alice', password: 'short' } });
  assert.strictEqual(r.status, 400);
  r = await request(base, 'POST', '/api/admin/users', { body: { id: 'a/b' } });
  assert.strictEqual(r.status, 400);
  r = await request(base, 'POST', '/api/admin/users', { body: { id: 'Alice', password: 'secret123', folders: ['DCIM'] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json, { id: 'alice', password: 'secret123', generated: false });
  assert.ok(fs.existsSync(path.join(media, 'Users', 'alice')), 'home folder created');
  r = await request(base, 'POST', '/api/admin/users', { body: { id: 'alice' } });
  assert.strictEqual(r.status, 409);
  r = await request(base, 'POST', '/api/admin/users', { body: { folders: ['dcim'] } });
  assert.strictEqual(r.status, 409, 'a folder can only belong to one user');
  r = await request(base, 'POST', '/api/admin/users', { body: {} });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.generated, true);
  assert.match(r.json.id, /^user-[a-z0-9]+$/);
  assert.ok(r.json.password.length >= 16);
  const bob = r.json;
  r = await request(base, 'GET', '/api/admin/overview');
  assert.strictEqual(r.json.users.length, 2);
  assert.strictEqual(r.json.users.find((u) => u.id === 'alice').stats.photos, 1);
  assert.strictEqual(r.json.users.find((u) => u.id === bob.id).stats.photos, 0);
  assert.strictEqual(r.json.library.unassigned, 0);
  assert.ok(!JSON.stringify(r.json).includes('secret123'));

  // sign in with user ID + password
  r = await request(base, 'POST', '/api/login', { body: { user: 'alice', password: 'wrong-pass' } });
  assert.strictEqual(r.status, 401);
  r = await request(base, 'POST', '/api/login', { body: { user: 'nobody', password: 'secret123' } });
  assert.strictEqual(r.status, 401);
  r = await request(base, 'POST', '/api/login', { body: { password: 'secret123' } });
  assert.strictEqual(r.status, 401);
  r = await request(base, 'POST', '/api/login', { body: { user: 'ALICE', password: 'secret123' } });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['set-cookie'][0], /HttpOnly/);
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  r = await request(base, 'POST', '/api/login', { body: { user: bob.id, password: bob.password } });
  assert.strictEqual(r.status, 200);
  const bobCookie = r.headers['set-cookie'][0].split(';')[0];
  r = await request(base, 'GET', '/api/status', { cookie });
  assert.strictEqual(r.json.user, 'alice');
  r = await request(base, 'GET', '/api/admin/overview', { cookie, headers: remoteHost });
  assert.strictEqual(r.status, 403, 'signed-in users still cannot use admin remotely');

  // static UI
  r = await request(base, 'GET', '/');
  assert.strictEqual(r.status, 200);
  const html = r.buf.toString();
  assert.match(html, /PocketPhotos/);
  let scriptPosition = -1;
  for (const script of ['/app.js', '/grid.js', '/viewer.js', '/pages.js', '/search.js', '/uploads.js', '/init.js']) {
    const position = html.indexOf(`<script src="${script}"></script>`);
    assert.ok(position > scriptPosition, `${script} loads in order`);
    scriptPosition = position;
    r = await request(base, 'GET', script);
    assert.strictEqual(r.status, 200, `${script} is served`);
  }
  r = await request(base, 'GET', '/x', { raw: '/..%2fsrc%2fapp.js' });
  assert.ok(r.status === 403 || r.status === 404);
  assert.ok(!r.buf.toString().includes('createApp'));
  r = await request(base, 'GET', '/x', { raw: '/%2e%2e%5c%2e%2e%5cpackage.json' });
  assert.ok(r.status === 403 || r.status === 404);

  // library listing
  r = await request(base, 'GET', '/api/media', { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.total, 2, 'hidden folder and non-media files are skipped');
  const img = r.json.items.find((i) => i.type === 'image');
  const vid = r.json.items.find((i) => i.type === 'video');
  assert.ok(img && vid);
  assert.strictEqual(img.taken, Date.parse('2023-10-15T12:34:56+03:00'));
  assert.strictEqual(img.w, 480, 'orientation 6 swaps width/height');
  assert.strictEqual(img.h, 640);
  if (hasFfmpeg) {
    assert.strictEqual(vid.taken, Date.parse('2022-05-01T10:00:00Z'));
    assert.ok(vid.dur >= 1.9 && vid.dur <= 2.1);
    assert.strictEqual(vid.w, 320);
  }
  if (hasFfmpeg) assert.strictEqual(r.json.items[0].id, img.id, 'newest first');

  // profile: own details + personalisation, validated, private to the user
  r = await request(base, 'GET', '/api/profile');
  assert.strictEqual(r.status, 401);
  r = await request(base, 'GET', '/api/profile', { cookie });
  assert.strictEqual(r.json.id, 'alice');
  assert.strictEqual(r.json.theme, 'auto');
  assert.strictEqual(r.json.avatar, null);
  r = await request(base, 'PATCH', '/api/profile', { cookie, body: {
    name: '  Alice <b>Smith</b>\u0007 ', email: 'Alice@Example.com', phone: '+91 98765-43210', birthday: '1990-04-23',
    theme: 'light', accent: 'green', grid: 'large', start: 'favorites', avatar: img.id, isAdmin: true, hash: 'x',
  } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.name, 'Alice <b>Smith</b>', 'trimmed, control chars removed (HTML is escaped by the UI)');
  assert.strictEqual(r.json.email, 'alice@example.com');
  assert.deepStrictEqual([r.json.theme, r.json.accent, r.json.grid, r.json.start], ['light', 'green', 'large', 'favorites']);
  assert.strictEqual(r.json.avatar.id, img.id);
  assert.ok(!('isAdmin' in app.store.data.users.alice.profile) && app.store.data.users.alice.hash !== 'x', 'unknown fields ignored');
  for (const bad of [{ email: 'nope' }, { phone: 'call me' }, { birthday: '2999-01-01' }, { birthday: '1990-02-30' },
    { theme: 'pink' }, { accent: '#fff' }, { grid: 'huge' }, { start: 'settings' }, { name: 'x'.repeat(61) }, { name: 42 },
    { avatar: vid.id }, { avatar: '__proto__' }]) {
    r = await request(base, 'PATCH', '/api/profile', { cookie, body: bad });
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
  }
  r = await request(base, 'PATCH', '/api/profile', { cookie: bobCookie, body: { avatar: img.id } });
  assert.strictEqual(r.status, 400, "cannot use someone else's photo as avatar");
  r = await request(base, 'GET', '/api/profile', { cookie: bobCookie });
  assert.strictEqual(r.json.name, '', "bob doesn't see alice's details");
  r = await request(base, 'GET', '/api/status', { cookie });
  assert.strictEqual(r.json.profile.accent, 'green');
  assert.strictEqual(r.json.profile.birthday, '1990-04-23');
  r = await request(base, 'GET', '/api/admin/overview');
  assert.strictEqual(r.json.users.find((u) => u.id === 'alice').name, 'Alice <b>Smith</b>');
  assert.ok(!JSON.stringify(r.json).includes('alice@example.com'), 'admin overview does not expose contact details');
  r = await request(base, 'PATCH', '/api/profile', { cookie, body: { email: '', phone: '', birthday: '', avatar: null } });
  assert.strictEqual(r.status, 200, 'fields can be cleared');
  assert.strictEqual(r.json.avatar, null);
  assert.strictEqual(r.json.name, 'Alice <b>Smith</b>', 'partial update keeps other fields');

  r = await request(base, 'GET', '/api/media?q=2023-10', { cookie });
  assert.strictEqual(r.json.total, 1);
  r = await request(base, 'GET', '/api/media?view=videos', { cookie });
  assert.strictEqual(r.json.total, 1);

  r = await request(base, 'GET', `/api/media/${img.id}`, { cookie });
  assert.strictEqual(r.json.make, 'samsung');
  assert.strictEqual(r.json.path, 'DCIM/Camera/photo.jpg');

  // thumbnails
  r = await request(base, 'GET', `/api/media/${img.id}/thumb`, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.buf[0], 0xff);
  if (hasFfmpeg) {
    assert.strictEqual(r.headers['content-type'], 'image/jpeg');
    assert.ok(r.buf.length < photo.length * 2);
    const thumbFile = app.thumbs.file('thumb', img.id);
    assert.ok(fs.existsSync(thumbFile), 'thumbnail cached on disk');
    r = await request(base, 'GET', `/api/media/${vid.id}/thumb`, { cookie });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/jpeg');
    const probe = execFileSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_streams', thumbFile]);
    const s = JSON.parse(probe).streams[0];
    assert.strictEqual(s.width, cfg.thumbSize);
    assert.strictEqual(s.height, cfg.thumbSize);
  }

  // range streaming
  r = await request(base, 'GET', `/api/media/${vid.id}/original`, { cookie, headers: { Range: 'bytes=0-99' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.buf.length, 100);
  assert.match(r.headers['content-range'], /^bytes 0-99\/\d+$/);
  assert.strictEqual(r.headers['content-type'], 'video/mp4');
  r = await request(base, 'GET', `/api/media/${vid.id}/original`, { cookie, headers: { Range: 'bytes=999999999-' } });
  assert.strictEqual(r.status, 416);
  r = await request(base, 'GET', `/api/media/${img.id}/original?download=1`, { cookie });
  assert.match(r.headers['content-disposition'], /attachment/);
  assert.strictEqual(r.buf.length, photo.length);

  // CSRF protection
  r = await request(base, 'POST', '/api/media/batch', { cookie, headers: { Origin: 'http://evil.example' }, body: { ids: [img.id], action: 'trash' } });
  assert.strictEqual(r.status, 403);

  // upload
  const up = withExif(hasFfmpeg ? fs.readFileSync(path.join(tmp, 'src.jpg')) : fakeJpeg(100, 50), { date: '2021:07:04 09:00:00', offset: '+00:00', orientation: 1 });
  r = await request(base, 'PUT', `/api/upload?name=${encodeURIComponent('beach day.jpg')}&mtime=1600000000000`, { cookie, body: up });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.duplicate, false);
  const upId = r.json.item.id;
  assert.ok(fs.existsSync(path.join(media, 'Users', 'alice', '2021', '07', 'beach day.jpg')), 'stored by date on the drive');
  r = await request(base, 'PUT', `/api/upload?name=${encodeURIComponent('copy.jpg')}`, { cookie, body: up });
  assert.strictEqual(r.json.duplicate, true, 'identical content is deduplicated');
  r = await request(base, 'PUT', '/api/upload?name=evil.exe', { cookie, body: Buffer.from('MZ') });
  assert.strictEqual(r.status, 415);
  r = await request(base, 'PUT', `/api/upload?name=${encodeURIComponent('../../escape.jpg')}`, { cookie, body: Buffer.concat([up, Buffer.from([0])]) });
  assert.strictEqual(r.status, 200);
  assert.ok(!fs.existsSync(path.join(tmp, 'escape.jpg')));
  assert.ok(r.json.item.name === 'escape.jpg');
  const escId = r.json.item.id;
  r = await request(base, 'GET', '/api/media', { cookie });
  assert.strictEqual(r.json.total, 4);

  // favorites
  r = await request(base, 'PATCH', `/api/media/${img.id}`, { cookie, body: { fav: true } });
  assert.strictEqual(r.json.fav, true);
  r = await request(base, 'GET', '/api/media?view=favorites', { cookie });
  assert.deepStrictEqual(r.json.items.map((i) => i.id), [img.id]);

  // albums
  r = await request(base, 'POST', '/api/albums', { cookie, body: { name: 'Trip', ids: [img.id] } });
  const albumId = r.json.id;
  r = await request(base, 'POST', '/api/media/batch', { cookie, body: { ids: [vid.id, upId], action: 'addToAlbum', album: albumId } });
  assert.strictEqual(r.status, 200);
  r = await request(base, 'GET', `/api/media?view=album&album=${albumId}`, { cookie });
  assert.strictEqual(r.json.total, 3);
  r = await request(base, 'PATCH', `/api/albums/${albumId}`, { cookie, body: { name: 'Summer trip' } });
  r = await request(base, 'GET', '/api/albums', { cookie });
  assert.strictEqual(r.json.albums[0].name, 'Summer trip');
  assert.strictEqual(r.json.albums[0].count, 3);
  if (hasFfmpeg) assert.strictEqual(r.json.albums[0].cover.id, img.id);
  r = await request(base, 'POST', '/api/media/batch', { cookie, body: { ids: [vid.id], action: 'removeFromAlbum', album: albumId } });
  r = await request(base, 'GET', `/api/media?view=album&album=${albumId}`, { cookie });
  assert.strictEqual(r.json.total, 2);

  // per-user isolation: Bob cannot see, open, change or add Alice's items or albums
  r = await request(base, 'GET', '/api/media', { cookie: bobCookie });
  assert.strictEqual(r.json.total, 0);
  for (const sub of ['', '/thumb', '/preview', '/original']) {
    r = await request(base, 'GET', `/api/media/${img.id}${sub}`, { cookie: bobCookie });
    assert.strictEqual(r.status, 404, `bob cannot GET ${sub || 'info'}`);
  }
  r = await request(base, 'PATCH', `/api/media/${img.id}`, { cookie: bobCookie, body: { fav: false } });
  assert.strictEqual(r.status, 404);
  r = await request(base, 'POST', '/api/media/batch', { cookie: bobCookie, body: { ids: [img.id, vid.id], action: 'trash' } });
  assert.strictEqual(r.json.count, 0, 'batch ignores items of other users');
  for (const id of ['__proto__', 'constructor', 'toString']) {
    r = await request(base, 'POST', '/api/media/batch', { cookie, body: { ids: [id], action: 'trash' } });
    assert.strictEqual(r.json.count, 0, `batch ignores inherited key ${id}`);
    r = await request(base, 'GET', `/api/media/${id}`, { cookie });
    assert.strictEqual(r.status, 404);
  }
  assert.strictEqual({}.trashed, undefined, 'Object.prototype untouched');
  r = await request(base, 'POST', '/api/media/batch', { cookie: bobCookie, body: { ids: [img.id], action: 'delete' } });
  assert.strictEqual(r.json.count, 0);
  assert.ok(fs.existsSync(path.join(media, 'DCIM', 'Camera', 'photo.jpg')));
  r = await request(base, 'GET', '/api/albums', { cookie: bobCookie });
  assert.strictEqual(r.json.albums.length, 0);
  r = await request(base, 'GET', `/api/albums/${albumId}`, { cookie: bobCookie });
  assert.strictEqual(r.status, 404);
  r = await request(base, 'GET', `/api/media?view=album&album=${albumId}`, { cookie: bobCookie });
  assert.ok(r.status === 404 || r.json.total === 0);
  r = await request(base, 'PATCH', `/api/albums/${albumId}`, { cookie: bobCookie, body: { name: 'Mine now' } });
  assert.strictEqual(r.status, 404);
  r = await request(base, 'DELETE', `/api/albums/${albumId}`, { cookie: bobCookie });
  assert.strictEqual(r.status, 404);
  r = await request(base, 'POST', '/api/albums', { cookie: bobCookie, body: { name: 'Bob', ids: [img.id] } });
  assert.strictEqual(r.json.count, 0, 'cannot put foreign items in own album');
  r = await request(base, 'POST', '/api/media/batch', { cookie: bobCookie, body: { ids: [], action: 'addToAlbum', album: albumId } });
  assert.strictEqual(r.status, 404, 'cannot add to a foreign album');
  r = await request(base, 'PUT', '/api/upload?name=bob.jpg', { cookie: bobCookie, body: up });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.duplicate, false, 'duplicate detection is per user');
  const bobItem = r.json.item.id;
  assert.ok(app.lib.items[bobItem].path.startsWith(`Users/${bob.id}/2021/07/`));
  r = await request(base, 'GET', `/api/media/${bobItem}`, { cookie });
  assert.strictEqual(r.status, 404, 'alice cannot see bob\'s upload');
  r = await request(base, 'GET', '/api/stats', { cookie: bobCookie });
  assert.strictEqual(r.json.photos, 1);
  assert.strictEqual(r.json.albums, 1);
  r = await request(base, 'GET', '/api/stats', { cookie: bobCookie, headers: remoteHost });
  assert.strictEqual(r.json.mediaDir, undefined, 'server paths hidden from remote users');
  r = await request(base, 'POST', '/api/trash/empty', { cookie: bobCookie });
  assert.strictEqual(r.json.count, 0);

  // admin can grant bob access to a sub-folder; the more specific folder wins
  r = await request(base, 'PUT', `/api/admin/users/${bob.id}/folders`, { body: { folders: ['DCIM/Camera'] } });
  assert.strictEqual(r.status, 200);
  r = await request(base, 'GET', '/api/media', { cookie: bobCookie });
  assert.deepStrictEqual(r.json.items.map((i) => i.id).sort(), [bobItem, img.id, vid.id].sort());
  r = await request(base, 'GET', `/api/media/${img.id}`, { cookie });
  assert.strictEqual(r.status, 404, 'alice lost DCIM/Camera to bob');
  r = await request(base, 'PUT', `/api/admin/users/${bob.id}/folders`, { body: { folders: ['../etc'] } });
  assert.strictEqual(r.status, 400);
  r = await request(base, 'PUT', `/api/admin/users/${bob.id}/folders`, { body: { folders: [] } });
  r = await request(base, 'GET', `/api/media/${img.id}`, { cookie });
  assert.strictEqual(r.status, 200);

  // trash, restore, delete forever
  r = await request(base, 'POST', '/api/media/batch', { cookie, body: { ids: [upId, escId], action: 'trash' } });
  r = await request(base, 'GET', '/api/media', { cookie });
  assert.strictEqual(r.json.total, 2);
  r = await request(base, 'GET', '/api/media?view=trash', { cookie });
  assert.strictEqual(r.json.total, 2);
  r = await request(base, 'POST', '/api/media/batch', { cookie, body: { ids: [escId], action: 'restore' } });
  r = await request(base, 'POST', '/api/media/batch', { cookie, body: { ids: [upId], action: 'delete' } });
  assert.strictEqual(r.json.count, 1);
  assert.ok(!fs.existsSync(path.join(media, 'Users', 'alice', '2021', '07', 'beach day.jpg')), 'file removed from drive');
  r = await request(base, 'GET', `/api/media?view=album&album=${albumId}`, { cookie });
  assert.strictEqual(r.json.total, 1, 'deleted item removed from album');

  // rescan picks up new files and removed files
  fs.copyFileSync(path.join(media, 'DCIM', 'Camera', 'photo.jpg'), path.join(media, 'DCIM', 'new 20200101_101010.jpg'));
  fs.unlinkSync(path.join(media, 'DCIM', 'Camera', 'clip.mp4'));
  r = await request(base, 'POST', '/api/scan', { cookie, headers: remoteHost });
  assert.strictEqual(r.status, 403, 'scan is admin-only');
  r = await request(base, 'POST', '/api/scan');
  assert.strictEqual(r.status, 202);
  const st = await app.lib.scan();
  assert.strictEqual(st.added, 1);
  assert.strictEqual(st.removed, 1);
  r = await request(base, 'GET', '/api/media', { cookie });
  assert.strictEqual(r.json.total, 3);
  r = await request(base, 'GET', `/api/media/${img.id}`, { cookie });
  assert.strictEqual(r.json.fav, true, 'favorites survive rescans');

  // empty-drive guard: an unmounted drive must not wipe the library
  while (app.thumbs.queue.size) await new Promise((res) => setTimeout(res, 50));
  await fsp.rename(path.join(media, 'DCIM'), path.join(tmp, 'DCIM-away'));
  await fsp.rename(path.join(media, 'Users'), path.join(tmp, 'Users-away'));
  const st2 = await app.lib.scan();
  assert.match(st2.error, /mounted/);
  assert.strictEqual(Object.keys(app.lib.items).length, 4);

  // stats & persistence
  r = await request(base, 'GET', '/api/stats', { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.disk && r.json.disk.total > 0);
  r = await request(base, 'POST', '/api/login', { body: { user: 'alice', password: 'secret123' } });
  const otherDevice = r.headers['set-cookie'][0].split(';')[0];
  r = await request(base, 'POST', '/api/password', { cookie, body: { current: 'wrong-pass', password: 'newpass123' } });
  assert.notStrictEqual(r.status, 200);
  r = await request(base, 'POST', '/api/password', { cookie, body: { current: 'secret123', password: 'newpass123' } });
  assert.strictEqual(r.status, 200);
  r = await request(base, 'GET', '/api/media', { cookie: otherDevice });
  assert.strictEqual(r.status, 401, 'other sessions revoked after password change');
  r = await request(base, 'GET', '/api/media', { cookie });
  assert.strictEqual(r.status, 200, 'current session kept');
  r = await request(base, 'GET', '/api/media', { cookie: bobCookie });
  assert.strictEqual(r.status, 200, 'other users unaffected');

  // admin reset / delete
  r = await request(base, 'POST', `/api/admin/users/${bob.id}/reset`, { body: {} });
  assert.strictEqual(r.json.generated, true);
  const bobPass2 = r.json.password;
  r = await request(base, 'GET', '/api/media', { cookie: bobCookie });
  assert.strictEqual(r.status, 401, 'reset signs the user out');
  r = await request(base, 'POST', '/api/login', { body: { user: bob.id, password: bobPass2 } });
  assert.strictEqual(r.status, 200);
  r = await request(base, 'DELETE', `/api/admin/users/${bob.id}`);
  assert.strictEqual(r.status, 200);
  r = await request(base, 'POST', '/api/login', { body: { user: bob.id, password: bobPass2 } });
  assert.strictEqual(r.status, 401);
  assert.ok(Object.values(app.lib.albums).every((a) => a.owner !== bob.id), 'deleted user albums removed');

  r = await request(base, 'POST', '/api/logout', { cookie });
  await app.store.close();
  const db = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'db.json'), 'utf8'));
  assert.strictEqual(Object.keys(db.items).length, 4);
  assert.ok(db.users.alice.hash && !JSON.stringify(db).includes('newpass123'));
  assert.strictEqual(db.auth, undefined);
});

test('network helpers classify addresses and local requests', () => {
  const { isPrivate, isLoopback, isLocalRequest } = require('../src/net');
  for (const ip of ['127.0.0.1', '::1', '192.168.1.5', '10.0.0.2', '172.20.1.1', '::ffff:192.168.0.9', 'fd00::1', 'fe80::1', '100.64.0.1']) {
    assert.ok(isPrivate(ip), ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2a00:1450::1', '100.128.0.1']) {
    assert.ok(!isPrivate(ip), ip);
  }
  assert.ok(isLoopback('::ffff:127.0.0.1'));
  const req = (ip, host) => ({ socket: { remoteAddress: ip }, headers: { host } });
  assert.ok(isLocalRequest(req('127.0.0.1', 'localhost:8080')));
  assert.ok(isLocalRequest(req('::1', '[::1]:8080')));
  assert.ok(!isLocalRequest(req('127.0.0.1', 'evil.com')), 'DNS rebinding');
  assert.ok(!isLocalRequest(req('192.168.1.9', 'localhost:8080')));
});

test('old single-password databases migrate to an "owner" user with the whole drive', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pp-mig-'));
  try {
    const { hashPassword } = require('../src/auth');
    const media = path.join(tmp, 'ssd');
    await fsp.mkdir(path.join(media, '.pocketphotos'), { recursive: true });
    fs.writeFileSync(path.join(media, 'a.jpg'), withExif(fakeJpeg(10, 10)));
    fs.writeFileSync(path.join(media, '.pocketphotos', 'db.json'), JSON.stringify({
      version: 1, items: {}, albums: { x: { id: 'x', name: 'Old', items: [], created: 1 } },
      auth: hashPassword('oldpass123'), sessions: { abc: { created: 1, expires: Date.now() + 1e6 } },
    }));
    const app = await createApp(loadConfig({ mediaDir: media, port: 0, host: '127.0.0.1', httpsPort: 0, rescanMinutes: 0, pregenerate: false, ffmpeg: 'none', ffprobe: 'none' }));
    const addr = await app.start();
    try {
      await app.lib.scan();
      const base = `http://127.0.0.1:${addr.port}`;
      let r = await request(base, 'POST', '/api/login', { body: { user: 'owner', password: 'oldpass123' } });
      assert.strictEqual(r.status, 200);
      const cookie = r.headers['set-cookie'][0].split(';')[0];
      r = await request(base, 'GET', '/api/media', { cookie });
      assert.strictEqual(r.json.total, 1);
      r = await request(base, 'GET', '/api/albums', { cookie });
      assert.strictEqual(r.json.albums.length, 1);
      assert.strictEqual(app.store.data.sessions.abc.user, 'owner', 'existing devices stay signed in as owner');
    } finally {
      await app.close();
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

const OPENSSL = process.env.PP_OPENSSL || 'openssl';
let hasOpenssl = true;
try {
  execFileSync(OPENSSL, ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}

test('HTTPS server with auto-generated certificate', { skip: !hasOpenssl && 'openssl not installed', timeout: 60000 }, async () => {
  const https = require('https');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pp-tls-'));
  const port = await new Promise((resolve) => {
    const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const app = await createApp(loadConfig({ mediaDir: tmp, port: 0, host: '127.0.0.1', httpsPort: port, openssl: OPENSSL, rescanMinutes: 0, pregenerate: false, ffmpeg: 'none', ffprobe: 'none' }));
  await app.start();
  try {
    assert.ok(app.tls.enabled, app.tls.error);
    assert.ok(app.tls.info.selfSigned);
    assert.ok(Array.isArray(app.tls.info.altNames) && app.tls.info.altNames.includes('DNS:localhost'), JSON.stringify(app.tls.info.altNames));
    const res = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/api/status', rejectUnauthorized: false }, (r) => {
        let d = '';
        r.on('data', (c) => { d += c; });
        r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(d) }));
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.local, true);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(app.cfg.tlsKey).mode & 0o777, 0o600);
  } finally {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('admin password: lockout after 5 wrong tries, change signs out, reset command clears it', async () => {
  const { AdminAuth } = require('../src/auth');
  const { Store } = require('../src/store');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pp-admin-'));
  try {
    const store = new Store(path.join(tmp, 'db.json'));
    const a = new AdminAuth(store);
    a.setup('correct-horse');
    const req = (t) => ({ headers: { cookie: t ? `pp_admin=${t}` : '' } });
    const tok = a.login('correct-horse');
    assert.ok(a.valid(req(tok)));
    assert.ok(!a.valid(req('forged')));
    for (let i = 0; i < 5; i++) assert.throws(() => a.login('nope'), (e) => e.status === 401);
    assert.throws(() => a.login('correct-horse'), (e) => e.status === 429, 'locked even with the right password');
    a.fails.lockedUntil = 0;
    assert.throws(() => a.change('wrong', 'new-secret'), (e) => e.status === 401);
    a.change('correct-horse', 'new-secret');
    assert.ok(!a.valid(req(tok)), 'changing the password signs out old sessions');
    assert.ok(a.valid(req(a.login('new-secret'))));
    await store.close();

    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'server.js'), '--reset-admin-password'], {
      env: { ...process.env, PP_MEDIA_DIR: tmp, PP_DATA_DIR: tmp, PP_CONFIG: path.join(tmp, 'none.json') }, encoding: 'utf8',
    });
    assert.match(out, /Admin password removed/);
    const s2 = new Store(path.join(tmp, 'db.json'));
    s2.load();
    assert.strictEqual(new AdminAuth(s2).isSet, false);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});