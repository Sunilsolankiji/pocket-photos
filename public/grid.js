'use strict';
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
    h.innerHTML = `${S.view === 'all' && !S.q && S.profile ? `<div class="greet${isBirthday(S.profile) ? ' bday' : ''}">${greeting(S.profile)}</div>` : ''}<h2>${titles[S.view]}</h2><span id="countLbl" style="color:var(--muted)"></span>`;
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

