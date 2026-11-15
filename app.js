'use strict';
/* RB IPTV – Xtream Codes client met zoeken op acteur (TMDB). */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const el = (t, a = {}, ...kids) => {
  const e = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const jset = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const msg = t => el('p', { class: 'muted' }, t);
const col = new Intl.Collator('nl', { numeric: true, sensitivity: 'base' });
const clean = n => n.replace(/^\s*\|[^|]*\|\s*/, '').replace(/\s*[-–]\s*(19|20)\d{2}\s*$/, '').replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// IndexedDB key/value (catalogi zijn te groot voor localStorage)
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('rbiptv', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, f) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const o = f(t.objectStore('kv'));
      t.oncomplete = () => res(o && o.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => null),
    set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => null),
    del: k => tx('readwrite', s => s.delete(k)).catch(() => null),
    clear: () => tx('readwrite', s => s.clear()).catch(() => null),
  };
})();

// ---------- state ----------
const DEF = { grid: 8, skipOn: true, skipSecs: 90, favOrder: ['series', 'movies', 'live'], hidden: { live: [], movies: [], series: [] } };
const S = {
  cfg: jget('cfg', null),
  set: Object.assign({}, DEF, jget('set', {})),
  favs: Object.assign({ live: [], movies: [], series: [] }, jget('favs', {})),
  view: 'live', sub: null, cache: {},
  cat: { live: 'all', movies: 'all', series: 'all' },
  sort: { movies: 'az', series: 'az' },
  favTab: null, searchTab: 'series', q: '', actorPick: null, refocus: null,
};
const saveSet = () => jset('set', S.set);
const NAMES = { series: 'Series', movies: 'Movies', live: 'Live TV' };

// ---------- Xtream API ----------
const srv = () => S.cfg.server.replace(/\/+$/, '');
const wrap = u => (S.cfg.proxy ? S.cfg.proxy + encodeURIComponent(u) : u);
async function api(action, extra = '') {
  const u = `${srv()}/player_api.php?username=${encodeURIComponent(S.cfg.user)}&password=${encodeURIComponent(S.cfg.pass)}${action ? '&action=' + action : ''}${extra}`;
  const r = await fetch(wrap(u));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const KINDS = {
  live: ['get_live_categories', 'get_live_streams'],
  movies: ['get_vod_categories', 'get_vod_streams'],
  series: ['get_series_categories', 'get_series'],
};
const mk = (kind, x) => {
  const name = x.name || '';
  const t = clean(name);
  return {
    kind, id: String(x.stream_id != null ? x.stream_id : x.series_id), name, title: t, n: norm(t),
    cat: String(x.category_id), icon: x.stream_icon || x.cover || '',
    rating: parseFloat(x.rating) || 0, added: +(x.added || x.last_modified || 0),
    ext: x.container_extension || 'mp4', rec: !!(+x.tv_archive),
  };
};
async function catalog(kind, force) {
  if (!force && S.cache[kind]) return S.cache[kind];
  if (!force) {
    const c = await idb.get('cat-' + kind);
    if (c && Date.now() - c.t < 12 * 3600e3) return (S.cache[kind] = c.d);
  }
  const [cats, items] = await Promise.all(KINDS[kind].map(a => api(a)));
  const d = {
    cats: (cats || []).map(c => ({ id: String(c.category_id), name: c.category_name })),
    items: (items || []).map(x => mk(kind, x)),
  };
  S.cache[kind] = d;
  idb.set('cat-' + kind, { t: Date.now(), d });
  return d;
}
const visible = (kind, d) => {
  const hid = new Set(S.set.hidden[kind]);
  return { cats: d.cats.filter(c => !hid.has(c.id)), items: d.items.filter(i => !hid.has(i.cat)) };
};

// ---------- TMDB ----------
async function tm(path, params = {}) {
  const key = S.cfg.tmdb;
  if (!key) throw new Error('Geen TMDB API-sleutel ingesteld');
  const u = new URL('https://api.themoviedb.org/3' + path);
  const opt = {};
  if (key.length > 40) opt.headers = { Authorization: 'Bearer ' + key }; else u.searchParams.set('api_key', key);
  u.searchParams.set('language', 'nl-NL');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, opt);
  if (!r.ok) throw new Error('TMDB ' + r.status);
  return r.json();
}
async function ranks(kind) {
  const key = 'tmdb-' + kind;
  if (S.cache[key]) return S.cache[key];
  const c = await idb.get(key);
  if (c && Date.now() - c.t < 24 * 3600e3) return (S.cache[key] = c.d);
  if (!S.cfg.tmdb) return { trend: {}, pop: {} };
  const t = kind === 'movies' ? 'movie' : 'tv', pages = [1, 2, 3, 4, 5];
  const toMap = res => {
    const m = {}; let i = 0;
    for (const r of res) for (const x of r.results || []) {
      const a = norm(x.title || x.name), b = norm(x.original_title || x.original_name);
      if (a && !(a in m)) m[a] = i;
      if (b && !(b in m)) m[b] = i;
      i++;
    }
    return m;
  };
  try {
    const [trend, pop] = await Promise.all([
      Promise.all(pages.map(n => tm(`/trending/${t}/week`, { page: n }))).then(toMap),
      Promise.all(pages.map(n => tm(`/${t}/popular`, { page: n }))).then(toMap),
    ]);
    const d = { trend, pop };
    S.cache[key] = d; idb.set(key, { t: Date.now(), d });
    return d;
  } catch (e) { return { trend: {}, pop: {} }; }
}

// ---------- UI bouwstenen ----------
const main = $('#main');
const pill = (label, active, fn) => el('button', { class: 'pill' + (active ? ' active' : ''), onclick: () => { S.refocus = label; fn(); } }, label);
const grid = () => el('div', { class: 'grid' });
const fmtRating = r => (r > 0 ? '★ ' + r.toFixed(1).replace('.', ',') : null);
const isFav = it => S.favs[it.kind].some(f => f.id === it.id);
function toggleFav(it, btn) {
  const a = S.favs[it.kind], i = a.findIndex(f => f.id === it.id);
  if (i >= 0) a.splice(i, 1); else a.push(it);
  jset('favs', S.favs);
  btn.classList.toggle('on', i < 0);
  btn.textContent = i < 0 ? '★' : '☆';
}
function starBtn(it) {
  const b = el('button', { class: 'star' + (isFav(it) ? ' on' : ''), 'aria-label': 'Favoriet' }, isFav(it) ? '★' : '☆');
  b.addEventListener('click', e => { e.stopPropagation(); toggleFav(it, b); });
  return b;
}
function card(it) {
  const r = fmtRating(it.rating);
  return el('div', { class: 'cw' },
    el('button', { class: 'card', onclick: () => openItem(it) },
      el('div', { class: 'poster' },
        it.icon ? el('img', { src: it.icon, loading: 'lazy', onerror: e => e.target.remove() }) : null,
        r ? el('span', { class: 'rating' }, r) : null),
      el('div', { class: 'ctitle' }, it.name)),
    starBtn(it));
}
function chunked(container, items, make, size = 72) {
  let i = 0;
  const sent = el('div', { class: 'sentinel' });
  const more = () => {
    const f = document.createDocumentFragment();
    for (let n = 0; n < size && i < items.length; n++, i++) f.append(make(items[i]));
    container.insertBefore(f, sent);
  };
  const obs = new IntersectionObserver(e => {
    if (!e[0].isIntersecting) return;
    obs.unobserve(sent); more();
    if (i < items.length) obs.observe(sent);
  }, { rootMargin: '900px' });
  container.append(sent);
  if (items.length) obs.observe(sent);
}

// EPG (huidig programma) lui laden voor zichtbare zenders
const epgQueue = []; let epgBusy = 0;
function epgPump() {
  while (epgBusy < 4 && epgQueue.length) {
    const row = epgQueue.shift(); epgBusy++;
    api('get_short_epg', `&stream_id=${row._it.id}&limit=1`).then(r => {
      const e = r && r.epg_listings && r.epg_listings[0];
      if (e && e.title) { try { row._epg.textContent = decodeURIComponent(escape(atob(e.title))); } catch (x) { row._epg.textContent = e.title; } }
    }).catch(() => {}).finally(() => { epgBusy--; epgPump(); });
  }
}
const epgObs = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting && !e.target._done) { e.target._done = true; epgQueue.push(e.target); epgPump(); }
}), { rootMargin: '300px' });
function liveRow(it) {
  const epg = el('div', { class: 'epg' });
  const row = el('div', { class: 'row' },
    el('button', { class: 'rowmain', onclick: () => playLive(it) },
      el('div', { class: 'logo-box' }, it.icon ? el('img', { src: it.icon, loading: 'lazy', onerror: e => e.target.remove() }) : null),
      el('div', { class: 'rtxt' }, el('div', { class: 'rname' }, it.name, it.rec ? el('span', { class: 'rec' }, '● rec') : null), epg)),
    starBtn(it));
  row._it = it; row._epg = epg; epgObs.observe(row);
  return row;
}

// ---------- views ----------
async function render() {
  document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  main.replaceChildren(el('p', { class: 'muted' }, 'Laden…'));
  try { await VIEWS[S.view](); } catch (e) { main.replaceChildren(msg('Fout: ' + e.message)); }
  if (S.refocus) {
    const b = [...main.querySelectorAll('.pill')].find(x => x.textContent === S.refocus);
    if (b) b.focus();
    S.refocus = null;
  }
}
const VIEWS = { live: liveView, movies: () => gridView('movies'), series: () => gridView('series'), favs: favView, search: searchView, menu: menuView };

async function liveView() {
  const { cats, items } = visible('live', await catalog('live'));
  const cur = S.cat.live;
  const bar = el('div', { class: 'pills scroll' },
    pill(`All (${items.length})`, cur === 'all', () => { S.cat.live = 'all'; render(); }),
    cats.map(c => pill(c.name, cur === c.id, () => { S.cat.live = c.id; render(); })));
  const list = el('div', { class: 'list' });
  chunked(list, cur === 'all' ? items : items.filter(i => i.cat === cur), liveRow, 60);
  main.replaceChildren(bar, list);
}

async function gridView(kind) {
  const { cats, items } = visible(kind, await catalog(kind));
  const cur = S.cat[kind], sort = S.sort[kind];
  const setCat = c => () => { S.cat[kind] = c; render(); };
  const bar = el('div', { class: 'pills scroll' },
    pill('🔥 Trending', cur === 'trending', setCat('trending')),
    pill(`All (${items.length})`, cur === 'all', setCat('all')),
    cats.map(c => pill(c.name, cur === c.id, setCat(c.id))));
  const sbar = el('div', { class: 'pills' },
    [['az', 'A–Z'], ['new', 'Newest'], ['pop', 'Most popular']].map(([k, n]) => pill(n, sort === k, () => { S.sort[kind] = k; render(); })));
  const notes = [];
  const rk = await ranks(kind);
  let list;
  if (cur === 'trending') {
    list = items.filter(i => rk.trend[i.n] !== undefined).sort((a, b) => rk.trend[a.n] - rk.trend[b.n]);
    if (!list.length) {
      list = items.slice().sort((a, b) => b.added - a.added).slice(0, 100);
      notes.push(msg(S.cfg.tmdb ? 'Geen TMDB-treffers; nieuwste titels getoond.' : 'Voeg een TMDB API-sleutel toe bij Menu voor echte trending-lijsten; nieuwste titels getoond.'));
    }
  } else {
    list = cur === 'all' ? items.slice() : items.filter(i => i.cat === cur);
    if (sort === 'az') list.sort((a, b) => col.compare(a.title, b.title));
    else if (sort === 'new') list.sort((a, b) => b.added - a.added);
    else list.sort((a, b) => ((rk.pop[a.n] ?? 1e9) - (rk.pop[b.n] ?? 1e9)) || b.rating - a.rating);
  }
  const g = grid();
  chunked(g, list, card, 72);
  main.replaceChildren(bar, sbar, ...notes, g);
}

async function favView() {
  const order = S.set.favOrder, tab = S.favTab || order[0];
  const bar = el('div', { class: 'pills' }, order.map(k => pill(NAMES[k], tab === k, () => { S.favTab = k; render(); })));
  const items = S.favs[tab];
  let body;
  if (!items.length) body = msg('No favourites in this section yet. Use the star on any title to add one.');
  else if (tab === 'live') { body = el('div', { class: 'list' }); chunked(body, items, liveRow, 60); }
  else { body = grid(); chunked(body, items, card, 72); }
  main.replaceChildren(bar, body);
}

async function searchView() {
  const input = el('input', { class: 'sinput', placeholder: 'Search...', value: S.q });
  const res = el('div', { class: 'sres' });
  let t;
  input.addEventListener('input', () => {
    S.q = input.value; clearTimeout(t);
    t = setTimeout(() => runSearch(res).catch(e => res.replaceChildren(msg(e.message))), 350);
  });
  const tabs = [['series', 'Series'], ['movies', 'Movies'], ['live', 'Live TV'], ['actor', 'Acteur']];
  const bar = el('div', { class: 'pills' }, tabs.map(([k, n]) => pill(n, S.searchTab === k, () => { S.searchTab = k; render(); })));
  main.replaceChildren(input, bar, res);
  if (!S.refocus && !S.q) input.focus();
  await runSearch(res).catch(e => res.replaceChildren(msg(e.message)));
}
function resultBlock(kind, list) {
  if (kind === 'live') { const w = el('div', { class: 'list' }); chunked(w, list, liveRow, 60); return w; }
  const g = grid(); chunked(g, list, card, 72); return g;
}
async function runSearch(res) {
  const q = S.q.trim();
  if (q.length < 2) { res.replaceChildren(msg('Typ minimaal 2 letters.')); return; }
  const tab = S.searchTab;
  if (tab === 'actor') return actorSearch(q, res);
  const { items } = visible(tab, await catalog(tab));
  const nq = norm(q);
  const list = items.filter(i => i.n.includes(nq)).slice(0, 300);
  res.replaceChildren(list.length ? resultBlock(tab, list) : msg('Geen resultaten.'));
}
async function actorSearch(q, res) {
  if (!S.cfg.tmdb) { res.replaceChildren(msg('Zoeken op acteur heeft een TMDB API-sleutel nodig. Vul die in bij Menu → TMDB.')); return; }
  const r = await tm('/search/person', { query: q });
  const people = (r.results || []).filter(p => p.known_for_department === 'Acting').concat((r.results || []).filter(p => p.known_for_department !== 'Acting')).slice(0, 6);
  if (!people.length) { res.replaceChildren(msg('Geen acteur gevonden.')); return; }
  const pid = people.some(p => p.id === S.actorPick) ? S.actorPick : people[0].id;
  const bar = el('div', { class: 'pills' }, people.map(p => pill(p.name, p.id === pid, () => { S.actorPick = p.id; runSearch(res).then(() => { const b = [...res.querySelectorAll('.pill')].find(x => x.textContent === p.name); if (b) b.focus(); }); })));
  res.replaceChildren(bar, msg('Titels laden…'));
  const cr = await tm(`/person/${pid}/combined_credits`);
  const sets = { movie: new Set(), tv: new Set() };
  for (const c of cr.cast || []) {
    const s = sets[c.media_type]; if (!s) continue;
    for (const t of [c.title, c.name, c.original_title, c.original_name]) { const n = norm(t); if (n) s.add(n); }
  }
  const out = [bar];
  for (const [kind, key] of [['movies', 'movie'], ['series', 'tv']]) {
    const { items } = visible(kind, await catalog(kind));
    const list = items.filter(i => sets[key].has(i.n)).sort((a, b) => b.added - a.added);
    if (list.length) out.push(el('h3', { class: 'sec' }, `${NAMES[kind]} (${list.length})`), resultBlock(kind, list));
  }
  if (out.length === 1) out.push(msg('Geen titels van deze acteur in jouw aanbod.'));
  res.replaceChildren(...out);
}
function searchActor(name) {
  closeDetail();
  S.view = 'search'; S.searchTab = 'actor'; S.q = name; S.actorPick = null;
  render();
}

// ---------- menu ----------
async function menuView() {
  if (S.sub) return catsView(S.sub);
  const hid = S.set.hidden;
  const item = (t, d, fn) => { const p = el('p', { class: 'muted' }, d); return el('button', { class: 'block menuitem', onclick: () => fn(p) }, el('h3', {}, t), p); };
  const catItem = k => item(`Edit ${NAMES[k]} categories`, `Show or hide ${NAMES[k]} categories (${hid[k].length} hidden)`, () => { S.sub = k; render(); });
  const gridPills = [3, 4, 5, 6, 7, 8, 9, 10].map(n => pill(String(n), S.set.grid === n, () => { S.set.grid = n; saveSet(); document.documentElement.style.setProperty('--cols', n); render(); }));
  const skipPills = [15, 30, 60, 90, 120].map(n => pill(n + 's', S.set.skipSecs === n, () => { S.set.skipSecs = n; saveSet(); render(); }));
  const order = S.set.favOrder;
  const move = (i, d) => () => { const o = order.slice(); [o[i], o[i + d]] = [o[i + d], o[i]]; S.set.favOrder = o; S.favTab = null; saveSet(); render(); };
  const rows = order.map((k, i) => el('div', { class: 'frow' }, `${i + 1}.  ${NAMES[k]}`,
    el('div', { class: 'btns' }, i > 0 ? el('button', { class: 'btn', onclick: move(i, -1) }, '↑ Up') : null, i < order.length - 1 ? el('button', { class: 'btn', onclick: move(i, 1) }, '↓ Down') : null)));
  const tmdb = el('input', { value: S.cfg.tmdb || '', placeholder: 'TMDB API-sleutel', autocapitalize: 'off' });
  const proxy = el('input', { value: S.cfg.proxy || '', placeholder: 'https://proxy.example/?url=', autocapitalize: 'off' });
  main.replaceChildren(
    el('h2', { class: 'title' }, 'Menu'),
    catItem('live'), catItem('movies'), catItem('series'),
    item('Refresh all catalog', 'Re-fetch the latest titles from your provider now', async p => {
      p.textContent = 'Bezig met verversen…';
      try { for (const k of ['live', 'movies', 'series']) { p.textContent = `Bezig met ${NAMES[k]}…`; await catalog(k, true); } await idb.del('tmdb-movies'); await idb.del('tmdb-series'); delete S.cache['tmdb-movies']; delete S.cache['tmdb-series']; p.textContent = 'Klaar – catalogus ververst.'; }
      catch (e) { p.textContent = 'Fout: ' + e.message; }
    }),
    item('Clear all cached data', 'Wipes cached catalogs and TMDB rankings for every section; the next load will be slower', async p => { await idb.clear(); S.cache = {}; p.textContent = 'Cache gewist.'; }),
    el('div', { class: 'block' }, el('h3', {}, 'Poster grid size'), el('p', { class: 'muted' }, 'How many columns of Movies/Series posters fit across the screen'), el('div', { class: 'pills' }, gridPills)),
    el('div', { class: 'block' }, el('h3', {}, 'Intro overslaan'),
      el('p', { class: 'muted' }, "Shows briefly at the start of an episode and jumps forward by the chosen amount. There's no real intro data available, so this is a fixed skip."),
      el('div', { class: 'pills' }, pill('Aan', S.set.skipOn, () => { S.set.skipOn = true; saveSet(); render(); }), pill('Uit', !S.set.skipOn, () => { S.set.skipOn = false; saveSet(); render(); })),
      el('div', { class: 'pills' }, skipPills)),
    el('div', { class: 'block' }, el('h3', {}, 'Favourites volgorde'), el('p', { class: 'muted' }, 'Order of the sections inside Favourites. The first one is what Favourites opens on.'), rows),
    el('div', { class: 'block' }, el('h3', {}, 'TMDB & verbinding'),
      el('p', { class: 'muted' }, 'Een TMDB-sleutel is nodig voor zoeken op acteur en voor Trending/Most popular. Een CORS-proxy is alleen nodig als je provider geen CORS toestaat.'),
      el('label', { class: 'fld' }, 'TMDB API-sleutel', tmdb), el('label', { class: 'fld' }, 'CORS-proxy (optioneel)', proxy),
      el('div', { class: 'pills' }, pill('Opslaan', false, () => { S.cfg.tmdb = tmdb.value.trim(); S.cfg.proxy = proxy.value.trim(); jset('cfg', S.cfg); S.cache = {}; render(); }))),
    el('button', { class: 'signout', onclick: () => { localStorage.removeItem('cfg'); idb.clear(); S.cfg = null; S.cache = {}; showLogin(); } }, 'Sign out'));
}
async function catsView(kind) {
  const d = await catalog(kind);
  const hid = new Set(S.set.hidden[kind]);
  const sync = () => { S.set.hidden[kind] = [...hid]; saveSet(); };
  const rows = d.cats.map(c => {
    const b = el('button', { class: 'catrow' }, '');
    const draw = () => { b.textContent = (hid.has(c.id) ? '☐  ' : '☑  ') + c.name; b.classList.toggle('off', hid.has(c.id)); };
    b.onclick = () => { if (hid.has(c.id)) hid.delete(c.id); else hid.add(c.id); sync(); draw(); };
    draw(); return b;
  });
  const all = (hide) => () => { hid.clear(); if (hide) d.cats.forEach(c => hid.add(c.id)); sync(); render(); };
  main.replaceChildren(
    el('h2', { class: 'title' }, `Edit ${NAMES[kind]} categories`),
    el('div', { class: 'pills' }, el('button', { class: 'btn', onclick: () => { S.sub = null; render(); } }, '← Terug'), pill('Alles tonen', false, all(false)), pill('Alles verbergen', false, all(true))),
    ...rows);
}

// ---------- detail + afspelen ----------
function closeDetail() { $('#detail').classList.add('hidden'); }
async function openItem(it) {
  const box = $('#detail');
  box.classList.remove('hidden');
  box.replaceChildren(el('p', { class: 'muted' }, 'Laden…'));
  let info = {};
  try { info = await api(it.kind === 'movies' ? 'get_vod_info' : 'get_series_info', (it.kind === 'movies' ? '&vod_id=' : '&series_id=') + it.id); } catch (e) { /* geen details */ }
  const inf = info.info || {};
  const cast = (inf.cast || inf.actors || '').split(/,\s*/).filter(Boolean).slice(0, 14);
  const close = el('button', { class: 'btn', onclick: closeDetail }, '← Terug');
  const body = el('div', { class: 'dbody' },
    el('h1', {}, it.title),
    el('p', { class: 'muted' }, [inf.releasedate || inf.releaseDate, inf.genre, inf.duration].filter(Boolean).join(' · ')),
    el('p', {}, inf.plot || inf.description || ''));
  if (it.kind === 'movies') {
    const ext = (info.movie_data && info.movie_data.container_extension) || it.ext;
    body.append(el('button', { class: 'pill active', onclick: () => play(`${srv()}/movie/${S.cfg.user}/${S.cfg.pass}/${it.id}.${ext}`) }, '▶ Afspelen'));
  } else {
    const eps = info.episodes || {};
    const seasons = Object.keys(eps).sort((a, b) => a - b);
    let cs = seasons[0];
    const sbar = el('div', { class: 'pills scroll' }), ebox = el('div', { class: 'eps' });
    const drawE = () => { const list = eps[cs] || []; ebox.replaceChildren(...list.map((ep, i) => el('button', { class: 'ep', onclick: () => playEp(list, i) }, `${ep.episode_num}. ${ep.title || ''}`))); };
    const drawS = () => sbar.replaceChildren(...seasons.map(s => el('button', { class: 'pill' + (s === cs ? ' active' : ''), onclick: () => { cs = s; drawS(); drawE(); sbar.querySelector('.active').focus(); } }, 'Season ' + s)));
    drawS(); drawE();
    body.append(sbar, ebox);
  }
  if (cast.length) body.append(el('h3', { class: 'sec' }, 'Acteurs'), el('div', { class: 'chips' }, cast.map(n => el('button', { class: 'chip', onclick: () => searchActor(n) }, n))));
  box.replaceChildren(close,
    el('div', { class: 'dwrap' }, el('div', { class: 'dposter' }, it.icon ? el('img', { src: it.icon, onerror: e => e.target.remove() }) : null), body));
  const first = body.querySelector('.pill.active, .ep') || close;
  first.focus();
}

let hls = null, Q = null, skipT = null;
const video = $('#video');
function playLive(it) { play(`${srv()}/live/${S.cfg.user}/${S.cfg.pass}/${it.id}.m3u8`, { live: true }); }
function playEp(list, i) {
  Q = { list, i };
  const ep = list[i];
  play(`${srv()}/series/${S.cfg.user}/${S.cfg.pass}/${ep.id}.${ep.container_extension || 'mp4'}`, { episode: true });
}
function play(url, o = {}) {
  if (!o.episode) Q = null;
  const p = $('#player');
  p.classList.remove('hidden');
  if (hls) { hls.destroy(); hls = null; }
  if (o.live && window.Hls && Hls.isSupported()) { hls = new Hls(); hls.loadSource(url); hls.attachMedia(video); }
  else video.src = url;
  video.play().catch(() => {});
  const b = $('#p-skip');
  b.classList.add('hidden'); clearTimeout(skipT);
  if (o.episode && S.set.skipOn) {
    video.addEventListener('playing', () => {
      b.textContent = `Intro overslaan (${S.set.skipSecs}s)`; b.classList.remove('hidden');
      skipT = setTimeout(() => b.classList.add('hidden'), 10000);
    }, { once: true });
  }
  $('#p-close').focus();
}
function closePlayer() {
  clearTimeout(skipT);
  video.pause(); if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src'); video.load();
  Q = null;
  $('#player').classList.add('hidden');
}
video.addEventListener('ended', () => { if (Q && Q.i + 1 < Q.list.length) playEp(Q.list, Q.i + 1); });
$('#p-close').addEventListener('click', closePlayer);
$('#p-skip').addEventListener('click', () => { video.currentTime += S.set.skipSecs; $('#p-skip').classList.add('hidden'); });

// ---------- login ----------
function showLogin() {
  $('#login').classList.remove('hidden');
  const c = S.cfg || {};
  $('#l-server').value = c.server || ''; $('#l-user').value = c.user || ''; $('#l-tmdb').value = c.tmdb || '';
  $('#l-server').focus();
}
$('#l-go').addEventListener('click', async () => {
  const err = $('#l-err'); err.textContent = 'Verbinden…';
  S.cfg = { server: $('#l-server').value.trim(), user: $('#l-user').value.trim(), pass: $('#l-pass').value, tmdb: $('#l-tmdb').value.trim(), proxy: (S.cfg && S.cfg.proxy) || '' };
  if (!/^https?:\/\//.test(S.cfg.server)) S.cfg.server = 'http://' + S.cfg.server;
  try {
    const r = await api('');
    if (!r.user_info || +r.user_info.auth !== 1) throw new Error('Inloggen mislukt – controleer je gegevens');
    jset('cfg', S.cfg); err.textContent = '';
    $('#login').classList.add('hidden'); S.cache = {}; render();
  } catch (e) { err.textContent = 'Fout: ' + e.message + ' (CORS? Probeer een proxy via Menu of het UWP-pakket.)'; }
});

// ---------- navigatie: toetsenbord + gamepad (Xbox) ----------
document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => {
  S.view = b.dataset.view; S.sub = null; if (S.view === 'favs') S.favTab = null;
  render();
}));
const activeRoot = () => {
  if (!$('#login').classList.contains('hidden')) return $('#login');
  if (!$('#player').classList.contains('hidden')) return $('#player');
  if (!$('#detail').classList.contains('hidden')) return $('#detail');
  return document;
};
const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled; };
function spatial(dir) {
  const list = [...activeRoot().querySelectorAll('button,input,video')].filter(vis);
  const cur = document.activeElement;
  if (!list.includes(cur)) { const f = list.find(x => x.classList.contains('active')) || list[0]; if (f) f.focus(); return true; }
  const r = cur.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
  let best = null, bs = Infinity;
  for (const c of list) {
    if (c === cur) continue;
    const q = c.getBoundingClientRect(), dx = (q.left + q.right) / 2 - cx, dy = (q.top + q.bottom) / 2 - cy;
    if ((dir === 'r' && dx <= 1) || (dir === 'l' && dx >= -1) || (dir === 'd' && dy <= 1) || (dir === 'u' && dy >= -1)) continue;
    const horiz = dir === 'l' || dir === 'r';
    const s = (horiz ? Math.abs(dx) : Math.abs(dy)) + (horiz ? Math.abs(dy) : Math.abs(dx)) * 3;
    if (s < bs) { bs = s; best = c; }
  }
  if (best) { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; }
  return false;
}
function goBack() {
  if (!$('#player').classList.contains('hidden')) { closePlayer(); return true; }
  if (!$('#detail').classList.contains('hidden')) { closeDetail(); return true; }
  if (S.sub) { S.sub = null; render(); return true; }
  return false;
}
let lastKey = 0;
const DIRS = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd', GamepadDPadLeft: 'l', GamepadDPadRight: 'r', GamepadDPadUp: 'u', GamepadDPadDown: 'd', GamepadLeftThumbstickLeft: 'l', GamepadLeftThumbstickRight: 'r', GamepadLeftThumbstickUp: 'u', GamepadLeftThumbstickDown: 'd' };
document.addEventListener('keydown', e => {
  lastKey = performance.now();
  if (['Escape', 'GamepadB', 'BrowserBack'].includes(e.key)) { if (goBack()) e.preventDefault(); return; }
  const dir = DIRS[e.key];
  if (!dir) return;
  const a = document.activeElement;
  if (a && a.tagName === 'INPUT' && (dir === 'l' || dir === 'r')) return;
  if (a === video && (dir === 'l' || dir === 'r') && !$('#player').classList.contains('hidden')) { video.currentTime += dir === 'r' ? 15 : -15; e.preventDefault(); return; }
  if (spatial(dir)) e.preventDefault();
});
// Gamepad API (werkt ook als de Xbox-shell geen toetsen mapt)
const gp = { last: {}, rep: {} };
function pollPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const now = performance.now();
  for (const p of pads) {
    if (!p) continue;
    const st = {
      u: p.buttons[12]?.pressed || p.axes[1] < -0.6, d: p.buttons[13]?.pressed || p.axes[1] > 0.6,
      l: p.buttons[14]?.pressed || p.axes[0] < -0.6, r: p.buttons[15]?.pressed || p.axes[0] > 0.6,
      a: p.buttons[0]?.pressed, b: p.buttons[1]?.pressed,
    };
    for (const k of ['u', 'd', 'l', 'r']) {
      if (st[k]) {
        if (!gp.last[k] || now - (gp.rep[k] || 0) > 220) {
          gp.rep[k] = now;
          if (now - lastKey > 250) {
            const a = document.activeElement;
            if (a === video && (k === 'l' || k === 'r') && !$('#player').classList.contains('hidden')) video.currentTime += k === 'r' ? 15 : -15;
            else if (!(a && a.tagName === 'INPUT' && (k === 'l' || k === 'r'))) spatial(k);
          }
        }
      }
      gp.last[k] = st[k];
    }
    if (st.a && !gp.last.a && now - lastKey > 250) { const a = document.activeElement; if (a === video) { video.paused ? video.play() : video.pause(); } else if (a && a.click) a.click(); }
    if (st.b && !gp.last.b && now - lastKey > 250) goBack();
    gp.last.a = st.a; gp.last.b = st.b;
  }
  requestAnimationFrame(pollPad);
}
requestAnimationFrame(pollPad);

// ---------- start ----------
document.documentElement.style.setProperty('--cols', S.set.grid);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!S.cfg) showLogin(); else render();
