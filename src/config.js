'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadConfig(overrides = {}) {
  const env = process.env;
  const cfgPath = env.PP_CONFIG || path.join(ROOT, 'config.json');
  let file = {};
  if (fs.existsSync(cfgPath)) {
    try {
      file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      throw new Error(`Could not read ${cfgPath}: ${e.message}`);
    }
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`${cfgPath} must contain a JSON object`);
  }
  const pick = (envKey, key, def) => {
    if (overrides[key] !== undefined) return overrides[key];
    if (env[envKey] !== undefined && env[envKey] !== '') return env[envKey];
    if (file[key] !== undefined) return file[key];
    return def;
  };
  const cfg = {
    mediaDir: pick('PP_MEDIA_DIR', 'mediaDir', path.join(ROOT, 'library')),
    dataDir: pick('PP_DATA_DIR', 'dataDir', ''),
    port: Number(pick('PP_PORT', 'port', 8080)),
    host: pick('PP_HOST', 'host', '0.0.0.0'),
    ffmpeg: pick('PP_FFMPEG', 'ffmpeg', 'ffmpeg'),
    ffprobe: pick('PP_FFPROBE', 'ffprobe', 'ffprobe'),
    workers: Number(pick('PP_WORKERS', 'workers', 2)),
    thumbSize: Number(pick('PP_THUMB_SIZE', 'thumbSize', 360)),
    previewSize: Number(pick('PP_PREVIEW_SIZE', 'previewSize', 2048)),
    uploadDir: pick('PP_UPLOAD_DIR', 'uploadDir', 'Users'),
    rescanMinutes: Number(pick('PP_RESCAN_MINUTES', 'rescanMinutes', 15)),
    trashDays: Number(pick('PP_TRASH_DAYS', 'trashDays', 30)),
    pregenerate: String(pick('PP_PREGENERATE', 'pregenerate', 'true')) !== 'false',
    maxUploadBytes: Number(pick('PP_MAX_UPLOAD_BYTES', 'maxUploadBytes', 20 * 1024 * 1024 * 1024)),
    httpsPort: Number(pick('PP_HTTPS_PORT', 'httpsPort', 8443)),
    tlsCert: pick('PP_TLS_CERT', 'tlsCert', ''),
    tlsKey: pick('PP_TLS_KEY', 'tlsKey', ''),
    openssl: pick('PP_OPENSSL', 'openssl', 'openssl'),
    publicHost: pick('PP_PUBLIC_HOST', 'publicHost', ''),
    duckdnsDomain: pick('PP_DUCKDNS_DOMAIN', 'duckdnsDomain', ''),
    duckdnsToken: pick('PP_DUCKDNS_TOKEN', 'duckdnsToken', ''),
    allowRemoteHttp: String(pick('PP_ALLOW_REMOTE_HTTP', 'allowRemoteHttp', 'false')) === 'true',
  };
  for (const k of Object.keys(file)) {
    if (!(k in cfg) && !k.startsWith('_')) console.warn(`[config] unknown setting "${k}" in ${cfgPath} (ignored)`);
  }
  validate(cfg);
  cfg.mediaDir = path.resolve(cfg.mediaDir);
  cfg.dataDir = path.resolve(cfg.dataDir || path.join(cfg.mediaDir, '.pocketphotos'));
  return cfg;
}

// [min, max] for every numeric setting; a bad value fails fast instead of silently becoming NaN.
const RANGES = {
  port: [0, 65535], httpsPort: [0, 65535], workers: [1, 16], thumbSize: [64, 1024], previewSize: [512, 8192],
  rescanMinutes: [0, 10080], trashDays: [1, 3650], maxUploadBytes: [1024 * 1024, 1024 ** 4],
};

function validate(cfg) {
  const bad = [];
  for (const [k, [min, max]] of Object.entries(RANGES)) {
    const v = cfg[k];
    if (!Number.isFinite(v) || v < min || v > max || ((k.endsWith('ort') || k === 'workers') && !Number.isInteger(v))) {
      bad.push(`${k}=${JSON.stringify(v)} (expected ${min}..${max})`);
    }
  }
  if (cfg.port && cfg.port === cfg.httpsPort) bad.push('port and httpsPort must differ');
  if (!String(cfg.mediaDir || '').trim()) bad.push('mediaDir is empty');
  if (bad.length) throw new Error('Invalid configuration: ' + bad.join(', '));
}

module.exports = { loadConfig, validate, ROOT };
