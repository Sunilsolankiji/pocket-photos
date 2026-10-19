'use strict';
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
