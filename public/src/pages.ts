'use strict';
// ---------- albums ----------
async function showAlbums() {
  resetContent();
  S.view = 'albums';
  S.done = true;
  const gen = S.gen;
  $('#viewHeader').innerHTML = '<h2>Albums</h2><button class="btn primary" id="newAlbum"><svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14m-7-7h14"/></svg>New album</button>';
  $('#newAlbum').onclick = async () => {
    const name = await promptDlg('New album', '', 'Create');
    if (!name) return;
    try { const a = await api('POST', '/api/albums', { name }); location.hash = '#/album/' + a.id; } catch (e) { toast(e.message); }
  };
  try {
    const { albums } = await api('GET', '/api/albums');
    if (gen !== S.gen) return;
    if (!albums.length) return showEmpty('No albums yet.<br><br>Select photos (long-press or tap the selection circle) and use Add to album.');
    const wrap = document.createElement('div');
    wrap.className = 'albums';
    wrap.innerHTML = albums.map((a) => `<div class="album-card" data-id="${a.id}"><div class="cover"${a.cover ? ` style="background-image:url('${thumbUrl(a.cover)}')"` : ''}>${a.cover ? '' : '<svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h6l2 2h8v10H4z"/><path d="M6 4h12"/></svg>'}</div><div class="name">${esc(a.name)}</div><div class="count">${plural(a.count, 'item')}</div></div>`).join('');
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
      <div class="row"><a class="btn" href="#/profile">Edit profile</a><button class="btn" id="chPass">Change password</button><button class="btn danger" id="logout">Sign out</button>
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

// ---------- profile page ----------
async function showProfile() {
  resetContent();
  S.view = 'profile';
  S.done = true;
  const gen = S.gen;
  $('#viewHeader').innerHTML = '<h2>Profile</h2>';
  let p;
  try { p = await api('GET', '/api/profile'); } catch (e) { return toast(e.message); }
  if (gen !== S.gen) return;
  applyProfile(p);
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const seg = (id, opts, cur) => `<div class="seg" id="${id}" role="radiogroup">${Object.entries(opts).map(([v, label]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === cur}">${label}</button>`).join('')}</div>`;
  $('#content').innerHTML = `<div class="cards">
    <div class="card profile-head">
      <button class="avatar big" id="pfAvatar" title="Change profile photo"></button>
      <div class="pf-who"><div class="pf-name" id="pfTitle"></div><div class="muted" id="pfSub"></div></div>
    </div>
    <form class="card" id="pfForm" novalidate><h3>Personal details</h3>
      <label class="field"><span>Display name</span><input type="text" id="pfName" maxlength="60" autocomplete="name" placeholder="e.g. Sunil Solanki"></label>
      <label class="field"><span>Email</span><input type="email" id="pfEmail" maxlength="254" autocomplete="email" placeholder="name@example.com"></label>
      <label class="field"><span>Phone</span><input type="tel" id="pfPhone" maxlength="24" autocomplete="tel" placeholder="+91 98765 43210"></label>
      <label class="field"><span>Birthday</span><input type="date" id="pfBday" min="1900-01-01" max="${ymd(today)}"></label>
      <p class="err" id="pfErr"></p>
      <div class="row"><button class="btn primary" type="submit">Save details</button></div>
      <p class="muted small">Stored only on your PocketPhotos server. Other users can't see them; the admin page shows your display name.</p>
    </form>
    <div class="card"><h3>Personalise</h3>
      <div class="field"><span>Theme</span>${seg('pfTheme', { auto: 'Auto', dark: 'Dark', light: 'Light' }, p.theme)}</div>
      <div class="field"><span>Accent colour</span><div class="swatches" id="pfAccent" role="radiogroup">${Object.entries(ACCENTS).map(([k, c]) => `<button type="button" role="radio" data-v="${k}" title="${k}" aria-checked="${k === p.accent}" style="background:${c[0]}"></button>`).join('')}</div></div>
      <div class="field"><span>Photo size</span>${seg('pfGrid', { small: 'Small', medium: 'Medium', large: 'Large' }, p.grid)}</div>
      <div class="field"><span>Open the app on</span><select id="pfStart">${Object.entries(START_PAGES).map(([k, v]) => `<option value="${k}"${k === p.start ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
  </div>`;
  const renderHead = (q) => {
    $('#pfTitle').textContent = q.name || q.id;
    let sub = `@${q.id}${q.created ? ` · member since ${new Date(q.created).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}` : ''}`;
    if (q.birthday) sub += isBirthday(q) ? ' · 🎂 Happy birthday!' : ` · 🎂 ${new Date(q.birthday + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
    $('#pfSub').textContent = sub;
    $('#pfAvatar').innerHTML = avatarHtml(q) + '<span class="cam">✎</span>';
  };
  renderHead(p);
  $('#pfName').value = p.name;
  $('#pfEmail').value = p.email;
  $('#pfPhone').value = p.phone;
  $('#pfBday').value = p.birthday;
  $('#pfForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#pfErr').textContent = '';
    try {
      const q = await saveProfile({ name: $('#pfName').value, email: $('#pfEmail').value, phone: $('#pfPhone').value, birthday: $('#pfBday').value });
      if (gen === S.gen) renderHead(q);
      toast('Profile saved');
    } catch (err) { $('#pfErr').textContent = err.message; }
  };
  const pick = (sel, key) => {
    $(sel).onclick = async (e) => {
      const b = e.target.closest('[data-v]');
      if (!b || b.getAttribute('aria-checked') === 'true') return;
      const prev = S.profile;
      $$('[data-v]', $(sel)).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      applyProfile({ ...prev, [key]: b.dataset.v });
      try { await saveProfile({ [key]: b.dataset.v }); } catch (err) {
        applyProfile(prev);
        $$('[data-v]', $(sel)).forEach((x) => x.setAttribute('aria-checked', String(x.dataset.v === prev[key])));
        toast(err.message);
      }
    };
  };
  pick('#pfTheme', 'theme');
  pick('#pfAccent', 'accent');
  pick('#pfGrid', 'grid');
  $('#pfStart').onchange = (e) => saveProfile({ start: e.target.value }).then(() => toast(`The app will open on ${START_PAGES[e.target.value]}`)).catch((err) => toast(err.message));
  $('#pfAvatar').onclick = async () => {
    const id = await pickAvatar();
    if (id === undefined) return;
    try { renderHead(await saveProfile({ avatar: id })); toast(id ? 'Profile photo updated' : 'Profile photo removed'); } catch (e) { toast(e.message); }
  };
}

/** Resolves to a photo id, '' to remove the photo, or undefined when cancelled. */
function pickAvatar() {
  return new Promise((res) => {
    const c = modal(`<h3>Choose a profile photo</h3><div class="avatar-pick" id="apGrid"></div>
      <div class="row"><button class="btn hidden" id="apMore">Load more</button><div class="spacer"></div>
      ${S.profile && S.profile.avatar ? '<button class="btn danger" data-r="">Remove photo</button>' : ''}<button class="btn" data-r="cancel">Cancel</button></div>`, () => res(undefined));
    let offset = 0;
    const more = async () => {
      try {
        const r = await api('GET', '/api/media?' + new URLSearchParams({ view: 'all', offset, limit: 60 }));
        offset += r.items.length;
        $('#apGrid').insertAdjacentHTML('beforeend', r.items.filter((it) => it.type === 'image')
          .map((it) => `<button data-r="${it.id}" title="${esc(it.name)}"><img loading="lazy" src="${thumbUrl(it)}" alt=""></button>`).join(''));
        $('#apMore').classList.toggle('hidden', offset >= r.total || !r.items.length);
        if (!$('#apGrid').children.length && offset >= r.total) $('#apGrid').innerHTML = '<p class="muted">No photos yet.</p>';
      } catch (e) { toast(e.message); }
    };
    $('#apMore').onclick = more;
    c.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      closeModal();
      res(b.dataset.r === 'cancel' ? undefined : b.dataset.r);
    };
    more();
  });
}
