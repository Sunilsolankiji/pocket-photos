'use strict';
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
    p.innerHTML = `<h3>Info</h3><div class="kv">${rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>
      ${d.type === 'image' && !d.trashed ? '<div class="row" style="margin-top:14px"><button class="btn" id="setAvatar">Use as profile photo</button></div>' : ''}`;
    const sa = $('#setAvatar');
    if (sa) sa.onclick = () => saveProfile({ avatar: it.id }).then(() => toast('Profile photo updated')).catch((e) => toast(e.message));
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

