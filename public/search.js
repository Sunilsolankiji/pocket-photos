'use strict';
// ---------- search ----------
let searchT = null;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    S.q = e.target.value.trim();
    if (['albums', 'settings', 'profile'].includes(S.view)) location.hash = '#/';
    else openGrid(S.view, S.album);
  }, 300);
});

