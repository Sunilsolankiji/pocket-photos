'use strict';
const { HttpError } = require('./library');

const THEMES = ['auto', 'dark', 'light'];
const ACCENTS = ['blue', 'green', 'yellow', 'red', 'purple', 'teal', 'orange'];
const GRIDS = ['small', 'medium', 'large'];
const START_PAGES = ['all', 'favorites', 'videos', 'albums'];
const DEFAULTS = Object.freeze({
  name: '', email: '', phone: '', birthday: '', avatar: '',
  theme: 'auto', accent: 'blue', grid: 'medium', start: 'all',
});

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{3,22}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function text(v, field, max) {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  v = v.replace(CONTROL, '').trim();
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v;
}

function oneOf(v, list, field) {
  if (!list.includes(v)) throw new HttpError(400, `${field} must be one of: ${list.join(', ')}`);
  return v;
}

function birthday(v) {
  v = text(v, 'Birthday', 10);
  if (!v) return '';
  const m = DATE_RE.exec(v);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new HttpError(400, 'Birthday must be a date like 1990-04-23');
  }
  if (+m[1] < 1900 || d.getTime() > Date.now()) throw new HttpError(400, 'Birthday must be between 1900 and today');
  return v;
}

/** The stored profile with defaults filled in (unknown/invalid stored values fall back to defaults). */
function readProfile(user) {
  const p = (user && user.profile) || {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof p[k] === 'string') out[k] = p[k];
  if (!THEMES.includes(out.theme)) out.theme = DEFAULTS.theme;
  if (!ACCENTS.includes(out.accent)) out.accent = DEFAULTS.accent;
  if (!GRIDS.includes(out.grid)) out.grid = DEFAULTS.grid;
  if (!START_PAGES.includes(out.start)) out.start = DEFAULTS.start;
  return out;
}

/**
 * Validates a partial update. Only known fields are taken; everything else is ignored.
 * `canUseAvatar(id)` must confirm the photo belongs to this user.
 */
function cleanUpdate(body, canUseAvatar) {
  const out = {};
  const has = (k) => Object.hasOwn(body, k) && body[k] !== undefined;
  if (has('name')) out.name = text(body.name, 'Name', 60);
  if (has('email')) {
    out.email = text(body.email, 'Email', 254).toLowerCase();
    if (out.email && !EMAIL_RE.test(out.email)) throw new HttpError(400, 'Email address looks wrong');
  }
  if (has('phone')) {
    out.phone = text(body.phone, 'Phone', 24);
    if (out.phone && !PHONE_RE.test(out.phone)) throw new HttpError(400, 'Phone number may only contain digits, spaces, +, -, ( and )');
  }
  if (has('birthday')) out.birthday = birthday(body.birthday);
  if (has('theme')) out.theme = oneOf(body.theme, THEMES, 'Theme');
  if (has('accent')) out.accent = oneOf(body.accent, ACCENTS, 'Accent');
  if (has('grid')) out.grid = oneOf(body.grid, GRIDS, 'Photo size');
  if (has('start')) out.start = oneOf(body.start, START_PAGES, 'Start page');
  if (has('avatar')) {
    out.avatar = body.avatar === null ? '' : text(body.avatar, 'Profile photo', 16);
    if (out.avatar && !canUseAvatar(out.avatar)) throw new HttpError(400, 'Profile photo must be one of your own photos');
  }
  return out;
}

module.exports = { readProfile, cleanUpdate, DEFAULTS, THEMES, ACCENTS, GRIDS, START_PAGES };
