'use strict';
/* PocketPhotos admin page – only served to requests made on the phone itself. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : 'never');
const folderLabel = (f) => (f === '' ? 'Entire drive' : f);

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function modal(html) {
  const m = $('#modal');
  $('#modalCard').innerHTML = html;
  m.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (v) => { m.classList.add('hidden'); m.onclick = null; resolve(v); };
    m.onclick = (e) => {
      if (e.target === m) return done(null);
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r);
    };
  });
}

const confirmBox = (title, text, okLabel = 'OK', danger = false) => modal(`<h3>${esc(title)}</h3><p style="margin:0">${text}</p>
  <div class="row" style="justify-content:flex-end"><button class="btn" data-r="0">Cancel</button>
  <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button></div>`).then((r) => r === '1');

let D = null;

function externalUrl() {
  const r = D.remote;
  const host = r.publicHost || r.publicIp;
  if (!host || !r.httpsPort) return null;
  return `https://${host}${r.httpsPort === 443 ? '' : `:${r.httpsPort}`}`;
}

function showCredentials(title, cred) {
  const lan = D.remote.lanIps[0];
  const ext = externalUrl();
  const text = `PocketPhotos sign-in\nUser ID: ${cred.id}\nPassword: ${cred.password}\n`
    + (lan ? `At home: http://${lan}:${D.remote.httpPort}\n` : '')
    + (ext ? `Anywhere: ${ext}\n` : '');
  modal(`<h3>${esc(title)}</h3>
    <p class="muted" style="margin:0">Share these with the person. The password is shown only now; it cannot be looked up later (you can reset it).</p>
    <div class="muted">User ID</div><div class="cred">${esc(cred.id)}</div>
    <div class="muted">Password</div><div class="cred">${esc(cred.password)}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="copyCred">Copy all</button><button class="btn primary" data-r="1">Done</button></div>`);
  $('#copyCred').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Copy failed – select the text manually');
    }
  };
}

function renderUsers() {
  const el = $('#users');
  if (!D.users.length) {
    el.innerHTML = '<p class="muted">No users yet. Create one above.</p>';
    return;
  }
  el.innerHTML = D.users.map((u) => {
    const st = u.stats;
    const sessions = u.sessions.length
      ? u.sessions.map((s) => `<div class="sess"><span>${esc(s.ip || '?')} · ${esc((s.ua || '').slice(0, 60))} · last seen ${esc(fmtTime(s.lastSeen))}</span>
          <button class="btn" data-act="revoke" data-key="${esc(s.key)}">Sign out</button></div>`).join('')
      : '<div class="sess">Not signed in anywhere</div>';
    return `<div class="user" data-id="${esc(u.id)}">
      <h4>${esc(u.id)} <span class="muted">${st.photos} photos · ${st.videos} videos · ${st.albums} albums · ${fmtBytes(st.bytes)}</span></h4>
      <div class="muted">Created ${esc(fmtTime(u.created))} · last sign-in ${esc(fmtTime(u.lastLogin))}</div>
      <div class="chips">
        <span class="chip home" title="Uploads from this user go here">${esc(u.home)} (uploads)</span>
        ${u.folders.map((f) => `<span class="chip">${esc(folderLabel(f))}<button title="Remove access" data-act="rmFolder" data-folder="${esc(f)}">✕</button></span>`).join('')}
      </div>
      <div class="row" style="margin:6px 0">
        <button class="btn" data-act="addFolder">Give folder access</button>
        <button class="btn" data-act="reset">Reset password</button>
        <button class="btn" data-act="signout">Sign out everywhere</button>
        <button class="btn danger" data-act="delete">Delete user</button>
      </div>
      ${sessions}
    </div>`;
  }).join('');
}

function renderLibrary() {
  const L = D.library;
  const sc = L.scan || {};
  const unassignedFolders = D.folders.filter((f) => !f.owner && !f.folder.includes('/'));
  $('#library').innerHTML = `<div class="kv">
      <div>Media folder</div><div><code>${esc(L.mediaDir)}</code>${L.readOnly ? ' <b class="bad">(read-only)</b>' : ''}</div>
      <div>Total</div><div>${L.photos.toLocaleString()} photos · ${L.videos.toLocaleString()} videos · ${fmtBytes(L.bytes)}</div>
      <div>Not visible to anyone</div><div class="${L.unassigned ? 'warn' : ''}">${L.unassigned.toLocaleString()} item(s)${unassignedFolders.length ? ` in ${unassignedFolders.map((f) => `<code>${esc(f.folder)}</code>`).join(', ')}` : ''}</div>
      <div>Last scan</div><div>${sc.running ? `Scanning… ${sc.found} found` : esc(fmtTime(sc.finished))}${sc.error ? ` <span class="bad">${esc(sc.error)}</span>` : ''}</div>
    </div>
    <p class="muted">Photos already on the drive (e.g. <code>DCIM</code>) belong to nobody until you give a user access to their folder. Each folder can belong to only one user; the most specific folder wins.</p>
    <div class="row"><button class="btn primary" id="rescan">Rescan drive</button></div>`;
  $('#rescan').onclick = async () => {
    try {
      await api('POST', '/api/admin/scan');
      toast('Scan started');
      setTimeout(load, 1500);
    } catch (e) { toast(e.message); }
  };
  $('#folderList').innerHTML = [{ folder: '' }, ...D.folders].map((f) => `<option value="${esc(f.folder)}">${esc(folderLabel(f.folder))}${f.count != null ? ` – ${f.count} items` : ''}${f.owner ? ` (${esc(f.owner)})` : ''}</option>`).join('');
}

function renderRemote() {
  const r = D.remote;
  const ext = externalUrl();
  const cert = r.cert;
  const ds = r.duckdns || {};
  const dsLine = ds.lastRun ? (ds.ok ? `<span class="ok">Updated ${esc(fmtTime(ds.lastRun))}</span>` : `<span class="bad">${esc(ds.error)}</span>`) : '<span class="muted">Not configured</span>';
  $('#remote').innerHTML = `<div class="kv">
      <div>At home (Wi-Fi)</div><div>${r.lanIps.length ? r.lanIps.map((ip) => `<code>http://${esc(ip)}:${r.httpPort}</code>`).join(' ') : '<span class="muted">No Wi-Fi address found</span>'}</div>
      <div>Secure server</div><div>${r.httpsEnabled ? `<span class="ok">HTTPS on port ${r.httpsPort}</span>` : `<span class="bad">Off</span>${r.httpsError ? ` – ${esc(r.httpsError)}` : ''}`}</div>
      <div>Certificate</div><div>${cert ? `${cert.selfSigned ? '<span class="warn">Self-signed</span> (browsers show a warning once)' : `<span class="ok">Trusted (${esc(cert.issuer)})</span>`}, valid until ${esc(new Date(cert.validTo).toLocaleDateString())}<br><span class="muted">${esc((cert.altNames || []).join(', '))}</span>` : '<span class="muted">none</span>'}</div>
      <div>Public IP</div><div>${r.publicIp ? `<code>${esc(r.publicIp)}</code>` : '<span class="muted">Unknown (no internet?)</span>'}</div>
      <div>DuckDNS</div><div>${dsLine}</div>
      <div>Address from anywhere</div><div>${ext ? `<code>${esc(ext)}</code>` : '<span class="muted">Needs HTTPS and a public IP or host name</span>'}</div>
    </div>
    ${cert && cert.selfSigned ? '<div class="row" style="margin-top:10px"><button class="btn" id="regen">Regenerate certificate</button><span class="muted">Do this after setting a DuckDNS name so it is included.</span></div>' : ''}

    <h3 style="margin-top:18px">Free web address (DuckDNS)</h3>
    <p class="muted" style="margin-top:0">Your home IP changes from time to time. Sign in at <b>duckdns.org</b>, add a sub-domain (e.g. <code>myphotos</code>) and paste the token here. The phone keeps the address up to date every 5 minutes.</p>
    <form id="dnsForm" class="grid2">
      <input type="text" id="dnsDomain" placeholder="Sub-domain, e.g. myphotos" value="${esc(r.settings.duckdnsDomain || '')}" autocomplete="off" autocapitalize="none">
      <input type="password" id="dnsToken" placeholder="${r.settings.duckdnsTokenSet ? 'Token saved – leave empty to keep' : 'DuckDNS token'}" autocomplete="off">
      <input type="text" id="pubHost" placeholder="Or your own host name (optional)" value="${esc(r.settings.publicHost || '')}" autocomplete="off" autocapitalize="none" style="grid-column:1/-1">
      <div class="row" style="grid-column:1/-1"><button class="btn primary" type="submit">Save</button>
        ${r.settings.duckdnsTokenSet ? '<button class="btn" type="button" id="dnsNow">Update now</button><button class="btn danger" type="button" id="dnsClear">Remove token</button>' : ''}</div>
    </form>

    <h3 style="margin-top:18px">Router setup (one time)</h3>
    <ol class="muted">
      <li>In your router's settings, give this phone a <b>fixed/reserved IP</b>${r.lanIps[0] ? ` (currently <code>${esc(r.lanIps[0])}</code>)` : ''}.</li>
      <li>Add a <b>port forward</b>: external TCP port <code>${r.httpsPort || 8443}</code> → <code>${esc(r.lanIps[0] || 'phone IP')}</code> port <code>${r.httpsPort || 8443}</code>. Do <b>not</b> forward port ${r.httpPort} (plain HTTP).</li>
      <li>Check the router's WAN/Internet IP equals the public IP above${r.publicIp ? ` (<code>${esc(r.publicIp)}</code>)` : ''}. If it is different (often <code>100.x.x.x</code>), your ISP uses CGNAT and port forwarding cannot work – ask the ISP for a public IP.</li>
      <li>From mobile data, open ${ext ? `<code>${esc(ext)}</code>` : 'the address above'}, accept the certificate warning once, and sign in with a user ID and password.</li>
    </ol>
    ${r.allowRemoteHttp ? '<p class="warn">allowRemoteHttp is on: plain HTTP is accepted from the internet. Passwords can be intercepted – turn it off.</p>' : ''}`;

  if ($('#regen')) {
    $('#regen').onclick = async () => {
      if (!(await confirmBox('Regenerate certificate?', 'Devices that already accepted the old certificate will show the warning once more.', 'Regenerate'))) return;
      try {
        await api('POST', '/api/admin/tls/regenerate');
        toast('New certificate created');
        load();
      } catch (e) { toast(e.message); }
    };
  }
  $('#dnsForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const out = await api('PUT', '/api/admin/settings', { duckdnsDomain: $('#dnsDomain').value, duckdnsToken: $('#dnsToken').value, publicHost: $('#pubHost').value });
      toast(out.status && out.status.ok === false ? `Saved, but: ${out.status.error}` : 'Saved');
      load();
    } catch (err) { toast(err.message); }
  };
  if ($('#dnsNow')) {
    $('#dnsNow').onclick = async () => {
      try {
        const s = await api('POST', '/api/admin/duckdns/update');
        toast(s.ok ? 'DuckDNS updated' : s.error || 'Not configured');
        load();
      } catch (err) { toast(err.message); }
    };
    $('#dnsClear').onclick = async () => {
      try {
        await api('PUT', '/api/admin/settings', { clearDuckdnsToken: true });
        toast('Token removed');
        load();
      } catch (err) { toast(err.message); }
    };
  }
}

function renderFails() {
  const f = D.failedLogins.slice().reverse().slice(0, 20);
  $('#fails').innerHTML = f.length
    ? `<table><tr><th>Time</th><th>IP</th><th>User ID tried</th></tr>${f.map((x) => `<tr><td>${esc(fmtTime(x.time))}</td><td>${esc(x.ip)}</td><td>${esc(x.user || '')}</td></tr>`).join('')}</table>`
    : '<p class="muted" style="margin:0">None.</p>';
}

async function load() {
  try {
    D = await api('GET', '/api/admin/overview');
  } catch (e) {
    document.querySelector('.admin').insertAdjacentHTML('beforeend', `<p class="err">${esc(e.message)}</p>`);
    return;
  }
  renderUsers();
  renderLibrary();
  renderRemote();
  renderFails();
}

$('#newUser').onsubmit = async (e) => {
  e.preventDefault();
  $('#nuErr').textContent = '';
  const folder = $('#nuFolder').value.trim();
  try {
    const cred = await api('POST', '/api/admin/users', {
      id: $('#nuId').value.trim(), password: $('#nuPass').value,
      folders: folder ? [folder.replace(/^\/+|\/+$/g, '')] : [],
    });
    $('#newUser').reset();
    await load();
    showCredentials('User created', cred);
  } catch (err) {
    $('#nuErr').textContent = err.message;
  }
};

$('#users').onclick = async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.closest('.user').dataset.id;
  const u = D.users.find((x) => x.id === id);
  try {
    switch (b.dataset.act) {
      case 'addFolder': {
        const r = await modal(`<h3>Give ${esc(id)} access to a folder</h3>
          <p class="muted" style="margin:0">Path inside the media folder, e.g. <code>DCIM</code> or <code>Pictures/Family</code>. Leave empty for the entire drive.</p>
          <input type="text" id="afFolder" list="folderList" autocomplete="off" autocapitalize="none" style="background:var(--bg);border:1px solid #333846;color:var(--text);padding:10px;border-radius:10px">
          <div class="row" style="justify-content:flex-end"><button class="btn" data-r="0">Cancel</button><button class="btn primary" data-r="1">Add</button></div>`);
        if (r !== '1') return;
        const f = $('#afFolder').value.trim().replace(/^\/+|\/+$/g, '');
        if (f === '' && !(await confirmBox('Entire drive?', `${esc(id)} will see every photo and video on the drive that is not in another user's folder.`, 'Give access', true))) return;
        await api('PUT', `/api/admin/users/${encodeURIComponent(id)}/folders`, { folders: [...u.folders, f] });
        toast('Access granted');
        break;
      }
      case 'rmFolder': {
        const f = b.dataset.folder;
        await api('PUT', `/api/admin/users/${encodeURIComponent(id)}/folders`, { folders: u.folders.filter((x) => x !== f) });
        toast('Access removed (files are untouched)');
        break;
      }
      case 'reset': {
        if (!(await confirmBox(`Reset password for ${id}?`, 'A new password is generated and the user is signed out on all devices.', 'Reset'))) return;
        const cred = await api('POST', `/api/admin/users/${encodeURIComponent(id)}/reset`, {});
        await load();
        showCredentials('New password', cred);
        return;
      }
      case 'signout': {
        const r = await api('POST', `/api/admin/users/${encodeURIComponent(id)}/signout`, {});
        toast(`Signed out ${r.revoked} device(s)`);
        break;
      }
      case 'revoke':
        await api('DELETE', `/api/admin/sessions/${encodeURIComponent(b.dataset.key)}`);
        toast('Device signed out');
        break;
      case 'delete':
        if (!(await confirmBox(`Delete ${id}?`, `They can no longer sign in and their albums are removed. <b>Photos and videos stay on the drive</b> (in <code>${esc(u.home)}</code>) and can be given to another user.`, 'Delete user', true))) return;
        await api('DELETE', `/api/admin/users/${encodeURIComponent(id)}`);
        toast('User deleted');
        break;
      default:
        return;
    }
    load();
  } catch (err) {
    toast(err.message);
  }
};

load();
