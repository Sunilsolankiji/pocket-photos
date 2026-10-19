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

// ---------- auth ----------
function showAuth() {
  const st = S.status || {};
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
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#uploadBtn').classList.toggle('hidden', S.status.readOnly);
  route();
}

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

// ---------- grid ----------
function openGrid(view, album) {
  resetContent();
  S.view = view;
  S.album = album || null;
  renderHeader();
  return loadMore();
}

function renderHeader() {
  const h = $('#viewHeader');
  const titles = { all: 'Photos', favorites: 'Favorites', videos: 'Videos' };
  if (S.view === 'album') {
    h.innerHTML = `<button class="icon-btn" id="backAlbums" title="Back">←</button><h2 id="albumTitle">Album</h2><span id="countLbl" style="color:var(--muted)"></span>
      <button class="btn" id="renameAlbum">Rename</button><button class="btn danger" id="deleteAlbum">Delete album</button>`;
    const id = S.album;
    api('GET', `/api/albums/${id}`).then((a) => { if (S.album === id) $('#albumTitle').textContent = a.name; }).catch((e) => toast(e.message));
    $('#backAlbums').onclick = () => (location.hash = '#/albums');
    $('#renameAlbum').onclick = async () => {
      const name = await promptDlg('Rename album', $('#albumTitle').textContent);
      if (!name) return;
      try { await api('PATCH', `/api/albums/${id}`, { name }); $('#albumTitle').textContent = name; } catch (e) { toast(e.message); }
    };
    $('#deleteAlbum').onclick = async () => {
      if (!(await confirmDlg('Delete this album? Photos and videos stay in your library.', 'Delete album'))) return;
      try { await api('DELETE', `/api/albums/${id}`); location.hash = '#/albums'; } catch (e) { toast(e.message); }
    };
  } else if (S.view === 'trash') {
    h.innerHTML = `<h2>Trash</h2><span style="color:var(--muted)">Items are permanently deleted from the drive after ${S.status.trashDays} days</span>
      ${S.status.readOnly ? '' : '<button class="btn danger" id="emptyTrash">Empty trash</button>'}`;
    const b = $('#emptyTrash');
    if (b) b.onclick = async () => {
      if (!S.total) return toast('Trash is empty');
      if (!(await confirmDlg(`Permanently delete ${plural(S.total, 'item')} from the drive? This cannot be undone.`, 'Empty trash'))) return;
      try { const r = await api('POST', '/api/trash/empty'); toast(`Deleted ${plural(r.count, 'item')}`); openGrid('trash'); } catch (e) { toast(e.message); }
    };
  } else {
    h.innerHTML = `<h2>${titles[S.view]}</h2><span id="countLbl" style="color:var(--muted)"></span>`;
  }
}

function sentinelNear() {
  return $('#sentinel').getBoundingClientRect().top < window.innerHeight + 1500;
}

function loadMore() {
  if (S.done) return Promise.resolve();
  if (S.loadingP) return S.loadingP;
  const gen = S.gen;
  const view = S.view;
  const p = (async () => {
    try {
      const qs = new URLSearchParams({ view, offset: S.items.length, limit: PAGE, q: S.q });
      if (S.album) qs.set('album', S.album);
      const r = await api('GET', '/api/media?' + qs);
      if (gen !== S.gen) return;
      S.total = r.total;
      const start = S.items.length;
      S.items.push(...r.items);
      appendTiles(r.items, start);
      S.done = S.items.length >= r.total || !r.items.length;
      updateCounts();
    } catch (e) {
      if (gen === S.gen) { S.done = true; toast(e.message); }
    }
  })();
  S.loadingP = p;
  return p.then(() => {
    if (gen !== S.gen) return;
    S.loadingP = null;
    if (!S.done && sentinelNear()) return loadMore();
  });
}

function updateCounts() {
  const c = $('#countLbl');
  if (c) c.textContent = S.total ? plural(S.total, 'item') : '';
  if (S.items.length) return showEmpty('');
  const msgs = {
    all: S.q ? 'No results.' : `Your library is empty.<br><br>Copy photos & videos onto the drive and press <b>Rescan</b> in Settings, or use <b>Upload</b>.`,
    favorites: 'No favorites yet. Tap ♥ on a photo to add it here.',
    videos: 'No videos.',
    trash: 'Trash is empty.',
    album: 'This album is empty. Select photos in the timeline and tap ＋ to add them.',
  };
  showEmpty(S.q && S.view !== 'all' ? 'No results.' : msgs[S.view] || '');
}

function tileEl(it, i) {
  const d = document.createElement('div');
  d.className = 'tile' + (S.selected.has(it.id) ? ' selected' : '');
  d.dataset.i = i;
  d.innerHTML = `<img loading="lazy" decoding="async" alt="" draggable="false" src="${thumbUrl(it)}">${it.type === 'video' ? `<span class="badge">▶ ${it.dur ? fmtDur(it.dur) : ''}</span>` : ''}${it.fav ? '<span class="fav">♥</span>' : ''}<span class="check">✓</span>`;
  d.querySelector('img').onerror = function () { this.remove(); d.classList.add('noimg'); };
  return d;
}

function appendTiles(items, start) {
  items.forEach((it, k) => {
    const key = dayKey(it.taken);
    if (key !== S.lastDay || !S.grid || !S.grid.isConnected) {
      S.lastDay = key;
      const sec = document.createElement('section');
      sec.className = 'day';
      sec.innerHTML = `<h3>${esc(dayLabel(it.taken))}</h3>`;
      S.grid = document.createElement('div');
      S.grid.className = 'grid';
      sec.appendChild(S.grid);
      $('#content').appendChild(sec);
    }
    S.grid.appendChild(tileEl(it, start + k));
  });
}

function tileFor(i) {
  return $(`#content .tile[data-i="${i}"]`);
}

function updateTile(i) {
  const old = tileFor(i);
  if (old && S.items[i]) old.replaceWith(tileEl(S.items[i], i));
}

/** Remove items from the current view without reloading. */
function removeItems(ids) {
  const set = new Set(ids);
  const tiles = $$('#content .tile');
  let removed = 0;
  S.items = S.items.filter((it, k) => {
    if (set.has(it.id)) {
      if (tiles[k]) tiles[k].remove();
      removed++;
      return false;
    }
    return true;
  });
  $$('#content .tile').forEach((t, k) => (t.dataset.i = k));
  $$('#content .day').forEach((d) => { if (!d.querySelector('.tile')) d.remove(); });
  ids.forEach((id) => S.selected.delete(id));
  S.total = Math.max(0, S.total - removed);
  updateSelbar();
  updateCounts();
  if (!S.done && sentinelNear()) loadMore();
}

async function refresh() {
  if (!['all', 'favorites', 'videos', 'trash', 'album'].includes(S.view)) return;
  const y = window.scrollY, n = S.items.length;
  clearSelection();
  await openGrid(S.view, S.album);
  for (let k = 0; k < 40 && !S.done && S.items.length < n; k++) await loadMore();
  window.scrollTo(0, y);
}

const observer = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '1500px 0px' });
observer.observe($('#sentinel'));

// tile interaction: click opens, check/long-press selects
let pressTimer = null, pressFired = false;
$('#content').addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.tile');
  pressFired = false;
  if (!t || e.button > 0) return;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressFired = true;
    toggleSel(+t.dataset.i, true);
    if (navigator.vibrate) navigator.vibrate(20);
  }, 480);
});
['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((ev) => $('#content').addEventListener(ev, () => clearTimeout(pressTimer), true));
window.addEventListener('scroll', () => clearTimeout(pressTimer), { passive: true });
$('#content').addEventListener('contextmenu', (e) => { if (e.target.closest('.tile')) e.preventDefault(); });
$('#content').addEventListener('click', (e) => {
  const t = e.target.closest('.tile');
  if (!t) return;
  if (pressFired) { pressFired = false; return; }
  const i = +t.dataset.i;
  if (e.shiftKey && S.lastSel >= 0) {
    const [a, b] = [Math.min(S.lastSel, i), Math.max(S.lastSel, i)];
    for (let k = a; k <= b; k++) toggleSel(k, true);
    return;
  }
  if (e.target.closest('.check') || S.selected.size) return toggleSel(i);
  openViewer(i);
});

// ---------- selection ----------
function toggleSel(i, force) {
  const it = S.items[i];
  if (!it) return;
  const on = force !== undefined ? force : !S.selected.has(it.id);
  if (on) S.selected.add(it.id); else S.selected.delete(it.id);
  S.lastSel = i;
  const el = tileFor(i);
  if (el) el.classList.toggle('selected', on);
  updateSelbar();
}
function updateSelbar() {
  const n = S.selected.size;
  $('#selbar').classList.toggle('hidden', !n);
  $('#content').classList.toggle('selecting', n > 0);
  $('#selCount').textContent = `${n} selected`;
  const trash = S.view === 'trash';
  const ro = S.status && S.status.readOnly;
  $$('#selbar [data-act]').forEach((b) => {
    const a = b.dataset.act;
    let show = trash ? a === 'restore' || a === 'delete' : !['restore', 'delete'].includes(a);
    if (a === 'removeFromAlbum') show = S.view === 'album';
    if (ro && (a === 'trash' || a === 'delete')) show = false;
    b.classList.toggle('hidden', !show);
  });
}
function clearSelection() {
  S.selected.clear();
  S.lastSel = -1;
  $$('#content .tile.selected').forEach((t) => t.classList.remove('selected'));
  updateSelbar();
}
$('#selClear').onclick = clearSelection;

function downloadMany(ids) {
  ids.forEach((id, k) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = `/api/media/${id}/original?download=1`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, k * 400));
  if (ids.length > 1) toast(`Downloading ${ids.length} files (allow multiple downloads if asked)`);
}

$('#selbar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const ids = [...S.selected];
  const act = b.dataset.act;
  try {
    if (act === 'favorite') {
      const byId = new Map(S.items.map((x, i) => [x.id, i]));
      const allFav = ids.every((id) => S.items[byId.get(id)] && S.items[byId.get(id)].fav);
      await api('POST', '/api/media/batch', { ids, action: allFav ? 'unfavorite' : 'favorite' });
      ids.forEach((id) => { const i = byId.get(id); if (i !== undefined) { S.items[i].fav = !allFav; updateTile(i); } });
      toast(allFav ? 'Removed from favorites' : 'Added to favorites');
      if (allFav && S.view === 'favorites') removeItems(ids);
      clearSelection();
    } else if (act === 'album') {
      if (await pickAlbum(ids)) clearSelection();
    } else if (act === 'download') {
      downloadMany(ids);
    } else if (act === 'trash') {
      await api('POST', '/api/media/batch', { ids, action: 'trash' });
      removeItems(ids);
      toast(`${plural(ids.length, 'item')} moved to trash`);
    } else if (act === 'restore') {
      await api('POST', '/api/media/batch', { ids, action: 'restore' });
      removeItems(ids);
      toast(`${plural(ids.length, 'item')} restored`);
    } else if (act === 'delete') {
      if (!(await confirmDlg(`Permanently delete ${plural(ids.length, 'item')} from the drive? This cannot be undone.`, 'Delete forever'))) return;
      await api('POST', '/api/media/batch', { ids, action: 'delete' });
      removeItems(ids);
      toast('Deleted');
    } else if (act === 'removeFromAlbum') {
      await api('POST', '/api/media/batch', { ids, action: 'removeFromAlbum', album: S.album });
      removeItems(ids);
      toast('Removed from album');
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------- viewer ----------
const viewerOpen = () => !$('#viewer').classList.contains('hidden');
function openViewer(i) {
  S.vi = i;
  const v = $('#viewer');
  if (!viewerOpen()) {
    v.classList.remove('hidden');
    history.pushState({ viewer: true }, '');
    document.body.style.overflow = 'hidden';
  }
  v.focus();
  showItem();
}
function closeViewer(fromHistory) {
  if (!viewerOpen()) return;
  $('#viewer').classList.add('hidden');
  $('#stage').innerHTML = '';
  document.body.style.overflow = '';
  const t = tileFor(S.vi);
  if (t) t.scrollIntoView({ block: 'nearest' });
  if (!fromHistory && history.state && history.state.viewer) history.back();
}
function showItem() {
  const it = S.items[S.vi];
  if (!it) return closeViewer();
  const st = $('#stage');
  st.innerHTML = '<div class="spinner"></div>';
  const done = () => { const sp = st.querySelector('.spinner'); if (sp) sp.remove(); };
  let el;
  if (it.type === 'video') {
    el = document.createElement('video');
    el.controls = true;
    el.autoplay = true;
    el.playsInline = true;
    el.preload = 'metadata';
    el.src = origUrl(it);
    el.onloadeddata = done;
    el.onerror = () => { done(); st.innerHTML = `<p style="padding:20px;text-align:center">This video format can't be played in your browser.<br><br><a href="${origUrl(it, true)}">Download it</a></p>`; };
  } else {
    el = new Image();
    el.alt = it.name;
    el.src = `/api/media/${it.id}/preview?v=${it.v}`;
    el.onload = done;
    el.onerror = () => { done(); st.innerHTML = `<p style="padding:20px;text-align:center">Can't display this file.<br><br><a href="${origUrl(it, true)}">Download it</a></p>`; };
  }
  st.appendChild(el);
  const trash = S.view === 'trash';
  const ro = S.status.readOnly;
  $('#vFav').textContent = it.fav ? '♥' : '♡';
  $('#vFav').classList.toggle('hidden', trash);
  $('#vAlbum').classList.toggle('hidden', trash);
  $('#vTrash').classList.toggle('hidden', trash || ro);
  $('#vRestore').classList.toggle('hidden', !trash);
  $('#vDownload').href = origUrl(it, true);
  $('#vPrev').style.visibility = S.vi > 0 ? 'visible' : 'hidden';
  $('#vNext').style.visibility = S.vi < S.items.length - 1 ? 'visible' : 'hidden';
  if (!$('#infoPanel').classList.contains('hidden')) loadInfo();
  const next = S.items[S.vi + 1];
  if (next && next.type === 'image') new Image().src = `/api/media/${next.id}/preview?v=${next.v}`;
  if (S.vi > S.items.length - 12) loadMore().then(() => { $('#vNext').style.visibility = S.vi < S.items.length - 1 ? 'visible' : 'hidden'; });
}
function step(d) {
  const n = S.vi + d;
  if (n >= 0 && n < S.items.length) { S.vi = n; showItem(); }
}
async function loadInfo() {
  const it = S.items[S.vi];
  const p = $('#infoPanel');
  p.innerHTML = '<h3>Info</h3>';
  try {
    const d = await api('GET', `/api/media/${it.id}`);
    if (S.items[S.vi] !== it) return;
    const rows = [
      ['Date', new Date(d.taken).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })],
      ['Name', esc(d.name)],
      ['Type', d.type === 'video' ? 'Video' : 'Photo'],
      d.w ? ['Size', `${Number(d.w) | 0} × ${Number(d.h) | 0}${d.w * d.h > 1e6 ? ` (${(d.w * d.h / 1e6).toFixed(1)} MP)` : ''}`] : null,
      d.dur ? ['Duration', fmtDur(d.dur)] : null,
      ['File size', fmtBytes(d.size)],
      d.make || d.model ? ['Camera', esc([d.make, d.model].filter(Boolean).join(' '))] : null,
      ['Location', `<code>${esc(d.path)}</code>`],
      d.albums.length ? ['Albums', d.albums.map((a) => `<a href="#/album/${a.id}">${esc(a.name)}</a>`).join(', ')] : null,
    ].filter(Boolean);
    p.innerHTML = `<h3>Info</h3><div class="kv">${rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>`;
  } catch (e) {
    p.innerHTML += `<p class="err">${esc(e.message)}</p>`;
  }
}
$('#vClose').onclick = () => closeViewer();
$('#vPrev').onclick = () => step(-1);
$('#vNext').onclick = () => step(1);
$('#vInfo').onclick = () => {
  const p = $('#infoPanel');
  p.classList.toggle('hidden');
  $('#viewer').classList.toggle('info-open', !p.classList.contains('hidden'));
  if (!p.classList.contains('hidden')) loadInfo();
};
$('#vFav').onclick = async () => {
  const it = S.items[S.vi];
  try {
    await api('PATCH', `/api/media/${it.id}`, { fav: !it.fav });
    it.fav = !it.fav;
    $('#vFav').textContent = it.fav ? '♥' : '♡';
    updateTile(S.vi);
  } catch (e) { toast(e.message); }
};
$('#vAlbum').onclick = () => pickAlbum([S.items[S.vi].id]).catch((e) => toast(e.message));
async function viewerRemove(action, msg) {
  const it = S.items[S.vi];
  try {
    await api('POST', '/api/media/batch', { ids: [it.id], action });
    removeItems([it.id]);
    toast(msg);
    if (!S.items.length) return closeViewer();
    S.vi = Math.min(S.vi, S.items.length - 1);
    showItem();
  } catch (e) { toast(e.message); }
}
$('#vTrash').onclick = () => viewerRemove('trash', 'Moved to trash');
$('#vRestore').onclick = () => viewerRemove('restore', 'Restored');

document.addEventListener('keydown', (e) => {
  if (!$('#modal').classList.contains('hidden')) { if (e.key === 'Escape') closeModal(true); return; }
  if (viewerOpen()) {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Escape') closeViewer();
    else if (e.key === 'Delete' && !$('#vTrash').classList.contains('hidden')) $('#vTrash').click();
    else if (e.key === 'f' && e.target.tagName !== 'INPUT') $('#vFav').click();
    return;
  }
  if (e.key === 'Escape' && S.selected.size) clearSelection();
});
let touch = null;
$('#stage').addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || (window.visualViewport && window.visualViewport.scale > 1.05)) { touch = null; return; }
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
$('#stage').addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 80) step(dx < 0 ? 1 : -1);
  else if (dy > 120 && Math.abs(dx) < 80) closeViewer();
}, { passive: true });

// ---------- albums ----------
async function showAlbums() {
  resetContent();
  S.view = 'albums';
  S.done = true;
  const gen = S.gen;
  $('#viewHeader').innerHTML = '<h2>Albums</h2><button class="btn primary" id="newAlbum">＋ New album</button>';
  $('#newAlbum').onclick = async () => {
    const name = await promptDlg('New album', '', 'Create');
    if (!name) return;
    try { const a = await api('POST', '/api/albums', { name }); location.hash = '#/album/' + a.id; } catch (e) { toast(e.message); }
  };
  try {
    const { albums } = await api('GET', '/api/albums');
    if (gen !== S.gen) return;
    if (!albums.length) return showEmpty('No albums yet.<br><br>Select photos (long-press or tick the circle) and tap ＋ to add them to an album.');
    const wrap = document.createElement('div');
    wrap.className = 'albums';
    wrap.innerHTML = albums.map((a) => `<div class="album-card" data-id="${a.id}"><div class="cover"${a.cover ? ` style="background-image:url('${thumbUrl(a.cover)}')"` : ''}>${a.cover ? '' : '▤'}</div><div class="name">${esc(a.name)}</div><div class="count">${plural(a.count, 'item')}</div></div>`).join('');
    wrap.onclick = (e) => { const c = e.target.closest('.album-card'); if (c) location.hash = '#/album/' + c.dataset.id; };
    $('#content').appendChild(wrap);
  } catch (e) { toast(e.message); }
}

// ---------- settings ----------
async function showSettings() {
  resetContent();
  S.view = 'settings';
  S.done = true;
  const gen = S.gen;
  $('#viewHeader').innerHTML = '<h2>Settings</h2>';
  let s;
  try { s = await api('GET', '/api/stats'); } catch (e) { return toast(e.message); }
  if (gen !== S.gen) return;
  const used = s.disk ? s.disk.total - s.disk.free : 0;
  $('#content').innerHTML = `<div class="cards">
    <div class="card"><h3>Library</h3><div class="kv">
      <div>Photos</div><div>${s.photos.toLocaleString()}</div><div>Videos</div><div>${s.videos.toLocaleString()}</div>
      <div>Favorites</div><div>${s.favorites.toLocaleString()}</div><div>Albums</div><div>${s.albums}</div>
      <div>In trash</div><div>${s.trashed}</div><div>Total size</div><div>${fmtBytes(s.bytes)}</div></div></div>
    ${s.disk ? `<div class="card"><h3>Drive storage</h3><div class="bar"><div style="width:${Math.round((used / s.disk.total) * 100)}%"></div></div>
      ${fmtBytes(used)} used of ${fmtBytes(s.disk.total)} · <b>${fmtBytes(s.disk.free)} free</b></div>` : ''}
    ${s.local ? `<div class="card"><h3>Scan library</h3><p id="scanInfo" style="margin-top:0"></p>
      <div class="row"><button class="btn primary" id="rescan">Rescan now</button></div></div>` : ''}
    <div class="card"><h3>Server</h3><div class="kv">
      ${s.local ? `<div>Media folder</div><div><code>${esc(s.mediaDir)}</code>${s.readOnly ? ' <b style="color:var(--danger)">(read-only)</b>' : ''}</div>
      <div>Data folder</div><div><code>${esc(s.dataDir)}</code></div>` : ''}
      <div>ffmpeg</div><div>${s.ffmpeg ? '✅ available' : '❌ missing – install with <code>pkg install ffmpeg</code>'}</div>
      <div>ffprobe</div><div>${s.ffprobe ? '✅ available' : '❌ missing'}</div>
      <div>Thumbnail jobs</div><div>${s.queue} pending</div><div>Version</div><div>${esc(s.version)}</div></div></div>
    <div class="card"><h3>Account</h3><p style="margin-top:0">Signed in as <b>${esc(S.status.user || '')}</b></p>
      <div class="row"><button class="btn" id="chPass">Change password</button><button class="btn danger" id="logout">Sign out</button>
      ${S.status.local ? '<a class="btn" href="/admin">Admin page</a>' : ''}</div></div>
  </div>`;
  const renderScan = (sc) => {
    const el = $('#scanInfo');
    if (!el) return;
    el.innerHTML = sc.running
      ? `Scanning… ${sc.found.toLocaleString()} files found, ${sc.added} new`
      : `${sc.finished ? `Last scan ${new Date(sc.finished).toLocaleString()}: ${sc.found.toLocaleString()} files, ${sc.added} new, ${sc.updated} changed, ${sc.removed} removed.` : 'Not scanned yet.'}${sc.error ? `<br><span class="err">${esc(sc.error)}</span>` : ''}`;
  };
  const poll = async () => {
    while (gen === S.gen) {
      const sc = await api('GET', '/api/scan').catch(() => null);
      if (!sc || gen !== S.gen) return;
      renderScan(sc);
      if (!sc.running) return sc;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  if (s.local) {
    renderScan(s.scan);
    if (s.scan.running) poll();
    $('#rescan').onclick = async () => {
      try {
        await api('POST', '/api/scan');
        const sc = await poll();
        if (sc) toast(`Scan finished: ${sc.added} new item(s)`);
      } catch (e) { toast(e.message); }
    };
  }
  $('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); S.status.authed = false; showAuth(); };
  $('#chPass').onclick = () => {
    const c = modal(`<h3>Change password</h3><input type="password" id="cpCur" placeholder="Current password" autocomplete="current-password">
      <input type="password" id="cpNew" placeholder="New password (min 8 chars)" autocomplete="new-password"><p class="err" id="cpErr"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-r="0">Cancel</button><button class="btn primary" data-r="1">Change</button></div>`);
    c.onclick = async (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === '0') return closeModal();
      try {
        await api('POST', '/api/password', { current: $('#cpCur').value, password: $('#cpNew').value });
        closeModal();
        toast('Password changed. Other devices were signed out.');
      } catch (err) { $('#cpErr').textContent = err.message; }
    };
  };
}

// ---------- search ----------
let searchT = null;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    S.q = e.target.value.trim();
    if (['albums', 'settings'].includes(S.view)) location.hash = '#/';
    else openGrid(S.view, S.album);
  }, 300);
});

// ---------- uploads ----------
const U = { queue: [], active: 0, ok: 0, dup: 0, fail: 0, total: 0, bytes: 0, doneBytes: 0, cur: new Map(), lastErr: '', hideT: null };
const UPLOAD_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?|mp4|m4v|mov|3gp|mkv|webm|avi|mts|m2ts|wmv)$/i;
function addUploads(files) {
  files = [...files].filter((f) => UPLOAD_EXT.test(f.name));
  if (!files.length) return toast('No supported photos or videos selected');
  clearTimeout(U.hideT);
  U.queue.push(...files);
  U.total += files.length;
  U.bytes += files.reduce((a, f) => a + f.size, 0);
  renderUploads();
  pump();
}
function pump() {
  while (U.active < 2 && U.queue.length) {
    const f = U.queue.shift();
    U.active++;
    uploadOne(f)
      .then((r) => (r.duplicate ? U.dup++ : U.ok++))
      .catch((e) => { U.fail++; U.lastErr = `${f.name}: ${e.message}`; })
      .finally(() => {
        U.active--;
        U.doneBytes += f.size;
        U.cur.delete(f);
        renderUploads();
        if (!U.active && !U.queue.length) finishUploads();
        else pump();
      });
  }
}
function uploadOne(f) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/upload?name=${encodeURIComponent(f.name)}&mtime=${f.lastModified || Date.now()}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { U.cur.set(f, e.loaded); renderUploadsSoon(); };
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (x.status >= 200 && x.status < 300) res(d);
      else rej(new Error(d.error || `HTTP ${x.status}`));
    };
    x.onerror = () => rej(new Error('Network error'));
    x.send(f);
  });
}
let renderPending = false;
function renderUploadsSoon() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => { renderPending = false; renderUploads(); }, 250);
}
function renderUploads() {
  const el = $('#uploads');
  const finished = U.ok + U.dup + U.fail;
  let sent = U.doneBytes;
  U.cur.forEach((v) => (sent += v));
  const pct = U.bytes ? Math.min(100, Math.round((sent / U.bytes) * 100)) : 100;
  const running = U.active || U.queue.length;
  el.classList.remove('hidden');
  el.innerHTML = `<b>${running ? `Uploading ${finished}/${U.total}` : `Upload complete`}</b> · ${pct}%
    <div class="bar"><div style="width:${pct}%"></div></div>
    <div style="color:var(--muted)">${U.ok} added${U.dup ? ` · ${U.dup} already in library` : ''}${U.fail ? ` · <span class="err">${U.fail} failed</span>` : ''}</div>
    ${U.fail ? `<div class="err" style="font-size:12px">${esc(U.lastErr)}</div>` : ''}`;
}
function finishUploads() {
  renderUploads();
  if (U.ok) refresh();
  U.hideT = setTimeout(() => {
    $('#uploads').classList.add('hidden');
    Object.assign(U, { ok: 0, dup: 0, fail: 0, total: 0, bytes: 0, doneBytes: 0, lastErr: '' });
  }, U.fail ? 12000 : 5000);
}
$('#uploadBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addUploads(e.target.files); e.target.value = ''; };
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || S.status?.readOnly || !S.status?.authed) return; dragDepth++; $('#drop').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.add('hidden');
  if (S.status?.authed && !S.status.readOnly) addUploads(e.dataTransfer.files);
});
window.addEventListener('beforeunload', (e) => { if (U.active || U.queue.length) { e.preventDefault(); e.returnValue = ''; } });

boot();
