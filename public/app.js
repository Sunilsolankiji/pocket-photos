'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const PAGE = 240;
const S = {
  view: 'all', album: null, q: '', items: [], total: 0, done: false, loadingP: null, gen: 0,
  selected: new Set(), lastSel: -1, vi: -1, status: null, lastDay: null, grid: null,
};

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thumbUrl = (it) => `/api/media/${it.id}/thumb?v=${it.v}`;
const origUrl = (it, dl) => `/api/media/${it.id}/original${dl ? '?download=1' : ''}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtDur(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && !/\/api\/(login|password)/.test(url)) {
    showAuth();
    throw new Error(data.error || 'Login required');
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- modals ----------
let modalCancel = null;
function modal(html, onCancel) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  modalCancel = onCancel || null;
  return $('#modalCard');
}
function closeModal(cancelled) {
  $('#modal').classList.add('hidden');
  $('#modalCard').innerHTML = '';
  const c = modalCancel;
  modalCancel = null;
  if (cancelled && c) c();
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(true); });
function confirmDlg(msg, okText = 'OK', danger = true) {
  return new Promise((res) => {
    const c = modal(`<h3>${esc(msg)}</h3><div class="row" style="justify-content:flex-end"><button class="btn" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okText)}</button></div>`, () => res(false));
    c.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { closeModal(); res(b.dataset.r === '1'); } };
  });
}
function promptDlg(title, value = '', okText = 'Save') {
  return new Promise((res) => {
    const c = modal(`<h3>${esc(title)}</h3><input type="text" id="pIn" value="${esc(value)}" maxlength="120"><div class="row" style="justify-content:flex-end"><button class="btn" data-r="0">Cancel</button><button class="btn primary" data-r="1">${esc(okText)}</button></div>`, () => res(null));
    const inp = $('#pIn');
    inp.focus();
    inp.select();
    const done = (v) => { closeModal(); res(v || null); };
    c.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1' ? inp.value.trim() : null); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); if (e.key === 'Escape') done(null); };
  });
}
async function pickAlbum(ids) {
  const { albums } = await api('GET', '/api/albums');
  return new Promise((res) => {
    const c = modal(`<h3>Add ${plural(ids.length, 'item')} to album</h3>
      <div class="row"><input type="text" id="newAlbumName" placeholder="New album name" maxlength="120" style="flex:1"><button class="btn primary" id="createAlbum">Create</button></div>
      <div class="pick-list">${albums.map((a) => `<button data-id="${a.id}">${a.cover ? `<img src="${thumbUrl(a.cover)}" alt="">` : '<span style="width:40px;text-align:center">▤</span>'}<span>${esc(a.name)}<br><small style="color:var(--muted)">${plural(a.count, 'item')}</small></span></button>`).join('')}</div>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="cancelPick">Cancel</button></div>`, () => res(false));
    const create = async () => {
      const name = $('#newAlbumName').value.trim();
      if (!name) return $('#newAlbumName').focus();
      try {
        await api('POST', '/api/albums', { name, ids });
        closeModal();
        toast(`Added to "${name}"`);
        res(true);
      } catch (e) { toast(e.message); }
    };
    $('#createAlbum').onclick = create;
    $('#newAlbumName').onkeydown = (e) => { if (e.key === 'Enter') create(); };
    $('#cancelPick').onclick = () => closeModal(true);
    c.querySelector('.pick-list').onclick = async (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      try {
        await api('POST', '/api/media/batch', { ids, action: 'addToAlbum', album: b.dataset.id });
        closeModal();
        toast('Added to album');
        res(true);
      } catch (err) { toast(err.message); }
    };
  });
}

// ---------- profile & personalisation ----------
const ACCENTS = {
  blue: ['#8ab4f8', '#1a73e8'], green: ['#81c995', '#188038'], yellow: ['#fdd663', '#b06000'], red: ['#f28b82', '#d93025'],
  purple: ['#c58af9', '#9334e6'], teal: ['#78d9ec', '#007b83'], orange: ['#fcad70', '#e8710a'],
};
const START_PAGES = { all: 'Photos', favorites: 'Favorites', videos: 'Videos', albums: 'Albums' };
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
const initials = (p) => ((p.name || p.id || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
const avatarHtml = (p) => (p && p.avatar ? `<img src="/api/media/${p.avatar.id}/thumb?v=${p.avatar.v}" alt="">` : `<span>${esc(p ? initials(p) : '')}</span>`);
function isBirthday(p) {
  if (!p || !p.birthday) return false;
  const now = new Date();
  return p.birthday.slice(5) === `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function applyProfile(p) {
  S.profile = p || null;
  const theme = p && p.theme !== 'auto' ? p.theme : darkMq.matches ? 'dark' : 'light';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.grid = (p && p.grid) || 'medium';
  const acc = ACCENTS[(p && p.accent) || 'blue'] || ACCENTS.blue;
  root.style.setProperty('--accent', acc[theme === 'light' ? 1 : 0]);
  $('meta[name=theme-color]').content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#111318';
  const me = $('#meBtn');
  me.innerHTML = avatarHtml(p);
  me.title = p ? `Profile – ${p.name || p.id}` : 'Profile';
}
darkMq.addEventListener('change', () => applyProfile(S.profile));
async function saveProfile(update) {
  const p = await api('PATCH', '/api/profile', update);
  applyProfile(p);
  return p;
}
function greeting(p) {
  if (!p) return '';
  const name = esc((p.name || p.id).split(/\s+/)[0]);
  if (isBirthday(p)) return `🎂 Happy birthday, ${name}!`;
  const h = new Date().getHours();
  return `${h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}, ${name}`;
}

// ---------- auth ----------
function showAuth() {
  const st = S.status || {};
  applyProfile(null);
  $('#app').classList.add('hidden');
  $('#viewer').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#authHint').textContent = st.hasUsers === false
    ? (st.local ? 'No accounts yet. Create one on the admin page.' : 'No accounts yet. On the phone running PocketPhotos, open http://localhost:' + (location.port || 80) + '/admin to create one.')
    : 'Sign in to your library';
  $('#authAdmin').classList.toggle('hidden', !st.local);
  $('#authUser').focus();
}
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#authErr').textContent = '';
  try {
    await api('POST', '/api/login', { user: $('#authUser').value.trim(), password: $('#authPass').value });
    $('#authPass').value = '';
    boot();
  } catch (err) {
    $('#authErr').textContent = err.message;
  }
});

async function boot() {
  try {
    S.status = await api('GET', '/api/status');
  } catch (e) {
    document.body.innerHTML = `<p style="padding:20px">Cannot reach server: ${esc(e.message)}</p>`;
    return;
  }
  if (!S.status.authed) return showAuth();
  applyProfile(S.status.profile);
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#uploadBtn').classList.toggle('hidden', S.status.readOnly);
  const start = S.profile && S.profile.start;
  if (!booted && start && start !== 'all' && /^#?\/?$/.test(location.hash)) history.replaceState(null, '', '#/' + start);
  booted = true;
  route();
}
let booted = false;

// ---------- routing ----------
function route() {
  const [v, arg] = location.hash.replace(/^#\/?/, '').split('/');
  clearSelection();
  closeViewer(true);
  const active = v === 'album' ? 'albums' : v || 'all';
  $$('#sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.view === active));
  window.scrollTo(0, 0);
  if (v === 'albums') return showAlbums();
  if (v === 'settings') return showSettings();
  if (v === 'profile') return showProfile();
  if (v === 'album' && arg) return openGrid('album', decodeURIComponent(arg));
  return openGrid(['favorites', 'videos', 'trash'].includes(v) ? v : 'all');
}
window.addEventListener('hashchange', () => { if (!$('#app').classList.contains('hidden')) route(); });
window.addEventListener('popstate', () => { if (!$('#viewer').classList.contains('hidden')) closeViewer(true); });

function resetContent() {
  S.gen++;
  S.items = [];
  S.total = 0;
  S.done = false;
  S.loadingP = null;
  S.lastDay = null;
  S.grid = null;
  $('#content').innerHTML = '';
  $('#viewHeader').innerHTML = '';
  $('#empty').classList.add('hidden');
}
function showEmpty(msg) {
  const e = $('#empty');
  e.innerHTML = msg;
  e.classList.toggle('hidden', !msg);
}
