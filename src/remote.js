'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const { run } = require('./proc');

function httpsGetText(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'PocketPhotos' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (body.length < 4096) body += d;
      });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(body.trim()) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function hasOpenssl(bin) {
  try {
    await run(bin, ['version'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Creates a 10-year self-signed certificate if none exists. Returns true if a cert/key pair is available. */
async function ensureCert(cfg, extraHosts = []) {
  if (fs.existsSync(cfg.tlsCert) && fs.existsSync(cfg.tlsKey)) return true;
  if (!(await hasOpenssl(cfg.openssl))) return false;
  await fsp.mkdir(path.dirname(cfg.tlsCert), { recursive: true });
  await fsp.mkdir(path.dirname(cfg.tlsKey), { recursive: true });
  const names = ['DNS:localhost', 'IP:127.0.0.1', ...extraHosts.filter(Boolean).map((h) => (/^[\d.]+$/.test(h) ? `IP:${h}` : `DNS:${h}`))];
  await run(cfg.openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
    '-keyout', cfg.tlsKey, '-out', cfg.tlsCert, '-subj', '/CN=PocketPhotos', '-addext', `subjectAltName=${[...new Set(names)].join(',')}`], { timeout: 60000 });
  try {
    await fsp.chmod(cfg.tlsKey, 0o600);
  } catch {
    /* not supported on this filesystem */
  }
  console.log(`[tls] created self-signed certificate ${cfg.tlsCert}`);
  return true;
}

async function readCert(cfg) {
  const [cert, key] = await Promise.all([fsp.readFile(cfg.tlsCert), fsp.readFile(cfg.tlsKey)]);
  const st = await fsp.stat(cfg.tlsCert);
  return { cert, key, mtime: st.mtimeMs };
}

/** Certificate summary for the admin page (subject, issuer, expiry, self-signed?). */
function describeCert(pem) {
  try {
    const { X509Certificate } = require('crypto');
    const c = new X509Certificate(pem);
    return {
      subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), validTo: Date.parse(c.validTo),
      altNames: (c.subjectAltName || '').split(',').map((s) => s.trim()).filter(Boolean), selfSigned: c.subject === c.issuer,
    };
  } catch {
    return null;
  }
}

/** Keeps a DuckDNS hostname pointed at the home's current public IP. */
class DuckDns {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.status = { lastRun: null, ok: null, error: null };
    this.timer = null;
  }

  async update() {
    const { duckdnsDomain: domain, duckdnsToken: token } = this.getSettings();
    if (!domain || !token) {
      this.status = { lastRun: null, ok: null, error: null };
      return this.status;
    }
    const sub = domain.replace(/\.duckdns\.org$/i, '');
    try {
      const body = await httpsGetText(`https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&ip=`);
      this.status = { lastRun: Date.now(), ok: body.startsWith('OK'), error: body.startsWith('OK') ? null : 'DuckDNS rejected the update (check domain and token)' };
    } catch (e) {
      this.status = { lastRun: Date.now(), ok: false, error: e.message };
    }
    if (!this.status.ok) console.warn('[duckdns]', this.status.error);
    return this.status;
  }

  start(minutes = 5) {
    this.stop();
    this.update().catch(() => {});
    this.timer = setInterval(() => this.update().catch(() => {}), minutes * 60000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

let ipCache = { at: 0, ip: null };
async function publicIp() {
  if (Date.now() - ipCache.at < 10 * 60000 && ipCache.ip) return ipCache.ip;
  try {
    const ip = await httpsGetText('https://api.ipify.org', 8000);
    if (/^[\d.:a-f]+$/i.test(ip)) ipCache = { at: Date.now(), ip };
  } catch {
    /* offline */
  }
  return ipCache.ip;
}

module.exports = { ensureCert, readCert, describeCert, DuckDns, publicIp, hasOpenssl };
