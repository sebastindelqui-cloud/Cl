// Ruta CR: interfaz. Mapa a pantalla completa, buscador arriba y panel abajo.
// La lógica de rutas está en buses-core.js y el mapa en buses-map.js.

import {
  mergeNetworks, planOptions, nextDepartures, routesAtStop, routeTimetable, stopsNear, distanceM, seniorFactor,
  formatClock, formatDuration, formatDistance, formatColones, formatIn, tripText,
} from './buses-core.js';
import { createMap, STYLES, stopSvg, stopDotSvg, pinSvg, meSvg } from './buses-map.js';
import { GOOGLE_MAPS_API_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const CENTER = [9.87, -84.1]; // sur de San José: Desamparados, Aserrí, Acosta
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ---------- Guardado local ----------

const KEY = { favs: 'rutacr.favs', recent: 'rutacr.recent', senior: 'rutacr.senior', gkey: 'rutacr.gkey', style: 'rutacr.mapstyle' };
function load(k, fallback) {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ }
}

const state = {
  net: null,
  map: null,
  from: null, // { lat, lng, name, kind: 'gps' | 'stop' | 'place' }
  to: null,
  me: null,
  options: [],
  selected: null,
  senior: load(KEY.senior, false),
  favs: load(KEY.favs, []),
  recent: load(KEY.recent, []),
  mapStyle: null,
  routeId: null,
  history: [],
};

// ---------- Utilidades de interfaz ----------

let toastTimer;
function toast(text, ms = 3200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function nowInfo() {
  const d = new Date();
  return { minute: d.getHours() * 60 + d.getMinutes(), weekday: d.getDay() };
}

const badge = (r) => `<span class="badge" style="background:${esc(r.color)};color:${esc(r.text)}">${esc(r.short)}</span>`;

// ---------- Panel inferior ----------

const SHEET = { peek: 'var(--sheet-peek)', half: 'var(--sheet-half)', full: 'var(--sheet-full)' };
function setSheet(s) {
  $('sheet').dataset.state = s;
  document.documentElement.style.setProperty('--sheet-h', SHEET[s]);
}

(function sheetDrag() {
  const h = $('handle');
  let startY = null;
  let startH = 0;
  h.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    startH = $('sheet').getBoundingClientRect().height;
    $('sheet').classList.add('dragging');
    h.setPointerCapture(e.pointerId);
  });
  h.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    const hpx = Math.max(110, Math.min(window.innerHeight - 160, startH + (startY - e.clientY)));
    document.documentElement.style.setProperty('--sheet-h', `${hpx}px`);
  });
  h.addEventListener('pointerup', (e) => {
    if (startY == null) return;
    const dy = startY - e.clientY;
    $('sheet').classList.remove('dragging');
    const cur = $('sheet').dataset.state;
    const order = ['peek', 'half', 'full'];
    let i = order.indexOf(cur);
    if (Math.abs(dy) < 8) i = (i + 1) % 3; // toque: siguiente tamaño
    else if (dy > 0) i = Math.min(2, i + (dy > 220 ? 2 : 1));
    else i = Math.max(0, i - (dy < -220 ? 2 : 1));
    setSheet(order[i]);
    startY = null;
  });
})();

function showView(name, { push = true } = {}) {
  const current = document.querySelector('.sheet-body > .view:not([hidden])')?.id.replace('view-', '');
  if (push && current && current !== name) state.history.push(current);
  for (const v of document.querySelectorAll('.sheet-body > .view')) v.hidden = v.id !== `view-${name}`;
  $('sheet-body').scrollTop = 0;
}

function goBack() {
  const prev = state.history.pop() || 'home';
  showView(prev, { push: false });
  if (prev === 'home') { clearTrip(); drawStops(); }
  if (prev === 'results') { drawOptionPreview(state.options[0]); }
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-back]')) goBack(); });

// ---------- Mapa ----------

/** Margen para encuadrar el mapa sin que lo tapen el buscador o el panel. */
function mapPad() {
  const card = $('search-card').getBoundingClientRect();
  const sheet = $('sheet').getBoundingClientRect();
  if (window.innerWidth >= 900) return { top: 40, right: 80, bottom: 40, left: sheet.right + 30 };
  const h = { peek: 148, half: window.innerHeight * 0.46, full: window.innerHeight * 0.8 }[$('sheet').dataset.state] || sheet.height;
  return { top: card.bottom + 20, right: 70, bottom: h + 20, left: 30 };
}

const layers = { stops: [], trip: [], route: [], pins: {}, me: null };
let stopMode = '';

/** Centra un punto en la parte visible del mapa (sin que lo tapen el buscador o el panel). */
function focusPoint(p, d = 0.0025) {
  state.map.fitBounds([[p.lat - d, p.lng - d], [p.lat + d, p.lng + d]], mapPad());
}

function clearLayer(list) { list.splice(0).forEach((x) => x.remove()); }

// Paradas en el mapa: solo las que se ven en pantalla (puede haber miles en el país).
const shownStops = new Map(); // índice de parada → marcador
const MAX_STOP_MARKERS = 350;

function drawStops() {
  const z = state.map.getZoom();
  const mode = z >= 15 ? 'sign' : z >= 13 ? 'dot' : 'none';
  if (mode !== stopMode) {
    for (const m of shownStops.values()) m.remove();
    shownStops.clear();
    stopMode = mode;
  }
  if (mode === 'none' || layers.trip.length || layers.route.length) {
    for (const m of shownStops.values()) m.remove();
    shownStops.clear();
    return;
  }
  const b = state.map.getBounds();
  if (!b) return;
  const padLat = (b.n - b.s) * 0.15;
  const padLng = (b.e - b.w) * 0.15;
  const want = new Set();
  state.net.stops.forEach((s, i) => {
    if (s.virtual || want.size >= MAX_STOP_MARKERS) return;
    if (s.lat < b.s - padLat || s.lat > b.n + padLat || s.lng < b.w - padLng || s.lng > b.e + padLng) return;
    want.add(i);
  });
  for (const [i, m] of shownStops) if (!want.has(i)) { m.remove(); shownStops.delete(i); }
  const big = mode === 'sign';
  for (const i of want) {
    if (shownStops.has(i)) continue;
    const s = state.net.stops[i];
    shownStops.set(i, state.map.addMarker([s.lat, s.lng], {
      svg: big ? stopSvg(28) : stopDotSvg(), size: big ? [28, 28] : [12, 12], anchor: big ? [14, 14] : [6, 6],
      z: 5, title: s.name, onClick: () => openStop(i),
    }));
  }
}

let moveTimer;
function onMapMove() {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(drawStops, 120);
}

function setPin(which, place) {
  layers.pins[which]?.remove();
  layers.pins[which] = null;
  if (!place || place.kind === 'gps') return;
  layers.pins[which] = state.map.addMarker([place.lat, place.lng], {
    svg: pinSvg(which === 'from' ? 'A' : 'B', which === 'from' ? '#138a4a' : '#ce1126'), size: [34, 44], anchor: [17, 43], z: 30,
  });
}

function setMe(p) {
  state.me = p;
  if (layers.me) layers.me.setLatLng([p.lat, p.lng]);
  else layers.me = state.map.addMarker([p.lat, p.lng], { svg: meSvg(), size: [28, 28], anchor: [14, 14], z: 25 });
}

function clearTrip() {
  clearLayer(layers.trip);
  clearLayer(layers.route);
}

/** Dibuja un viaje: buses con el color de su ruta, caminatas punteadas y las paradas de subida/bajada. */
function drawTrip(o, { fit = true } = {}) {
  clearTrip();
  layers.trip.push({ remove() {} }); // marca que hay un viaje dibujado
  drawStops();
  const pts = [];
  for (const l of o.legs) {
    if (l.type === 'walk') {
      const line = [[l.from.lat, l.from.lng], [l.to.lat, l.to.lng]];
      layers.trip.push(state.map.addLine(line, { color: '#5b6478', weight: 5, dashed: true, z: 2 }));
      pts.push(...line);
      continue;
    }
    const p = l.pattern;
    const shape = sliceShape(p, l.boardPos, l.alightPos);
    layers.trip.push(state.map.addLine(shape, { color: '#ffffff', weight: 10, z: 3 }));
    layers.trip.push(state.map.addLine(shape, { color: l.route.color, weight: 6, z: 4 }));
    for (let i = l.boardPos + 1; i < l.alightPos; i += 1) {
      const s = state.net.stops[p.stops[i]];
      layers.trip.push(state.map.addMarker([s.lat, s.lng], { svg: stopDotSvg(l.route.color), size: [12, 12], anchor: [6, 6], z: 6, title: s.name }));
    }
    for (const s of [l.from, l.to]) {
      const i = state.net.stops.indexOf(s);
      layers.trip.push(state.map.addMarker([s.lat, s.lng], { svg: stopSvg(30, true), size: [30, 30], anchor: [15, 15], z: 20, title: s.name, onClick: () => openStop(i) }));
    }
    pts.push(...shape);
  }
  if (fit && pts.length) state.map.fitBounds(pts, mapPad());
}

/** Parte del trazado de un recorrido entre dos paradas. */
function sliceShape(p, a, b) {
  const S = state.net.stops;
  const A = S[p.stops[a]];
  const B = S[p.stops[b]];
  const near = (pt, s) => (pt[0] - s.lat) ** 2 + (pt[1] - s.lng) ** 2;
  let ia = 0;
  let best = Infinity;
  p.shape.forEach((pt, i) => { const d = near(pt, A); if (d < best) { best = d; ia = i; } });
  let ib = ia;
  best = Infinity;
  for (let i = ia; i < p.shape.length; i += 1) { const d = near(p.shape[i], B); if (d < best) { best = d; ib = i; } }
  return [[A.lat, A.lng], ...p.shape.slice(ia, ib + 1), [B.lat, B.lng]];
}

function drawRoute(routeId, { fit = true } = {}) {
  state.routeId = routeId;
  clearTrip();
  layers.route.push({ remove() {} });
  drawStops();
  const pts = [];
  const seen = new Set();
  for (const p of state.net.patterns.filter((x) => x.route === routeId)) {
    const r = state.net.routes.find((x) => x.id === routeId);
    layers.route.push(state.map.addLine(p.shape, { color: '#ffffff', weight: 9, z: 3 }));
    layers.route.push(state.map.addLine(p.shape, { color: r.color, weight: 5, z: 4 }));
    pts.push(...p.shape);
    for (const si of p.stops) {
      if (seen.has(si)) continue;
      seen.add(si);
      const s = state.net.stops[si];
      layers.route.push(state.map.addMarker([s.lat, s.lng], { svg: stopDotSvg(r.color), size: [12, 12], anchor: [6, 6], z: 6, title: s.name, onClick: () => openStop(si) }));
    }
  }
  if (fit) state.map.fitBounds(pts, mapPad());
}

// ---------- Ubicación ----------

function locate({ quiet = false } = {}) {
  if (!navigator.geolocation) {
    if (state.from?.kind === 'gps' && state.from.lat == null) setPlace('from', null);
    if (!quiet) toast('Este navegador no permite usar la ubicación.');
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => {
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    setMe(p);
    if (!state.from || state.from.kind === 'gps') setPlace('from', { ...p, name: 'Tu ubicación', kind: 'gps' });
    focusPoint(p);
    renderNearby();
    const near = stopsNear(state.net, p, 3000)[0];
    if (!near && !quiet) toast('Todavía no hay rutas de Ruta CR cerca de ti. Puedes ver la ruta en Google Maps.', 5000);
  }, () => {
    if (state.from?.kind === 'gps' && state.from.lat == null) setPlace('from', null);
    toast(quiet ? 'Sin permiso de ubicación: toca el mapa para elegir de dónde sales.' : 'No se pudo obtener tu ubicación. Revisa el permiso de ubicación del navegador.', 5000);
  }, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 });
}

$('locate').addEventListener('click', () => locate());

// ---------- Origen, destino y búsqueda ----------

function setPlace(which, place) {
  state[which] = place;
  $(`${which}-input`).value = place ? place.name : '';
  setPin(which, place);
}

const ICONS = {
  stop: stopSvg(32),
  place: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
  gps: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21z"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 3.5 2.1-.8 1.3L11 13V7h2z"/></svg>',
};

let activeField = null;
let suggestTimer;

function suggestionsFor(text) {
  const q = norm(text);
  const items = [];
  if (activeField === 'from') items.push({ icon: 'gps', main: 'Tu ubicación', sub: 'Usar el GPS del teléfono', act: 'gps' });
  if (!q) {
    for (const r of state.recent.slice(0, 4)) items.push({ icon: 'clock', main: r.to.name, sub: `Desde ${r.from.name}`, act: 'recent', data: r });
    return items;
  }
  const stops = state.net.stops
    .map((s, i) => ({ s, i, n: norm(s.name) }))
    .filter((x) => !x.s.virtual && x.n.includes(q))
    .sort((a, b) => a.n.indexOf(q) - b.n.indexOf(q))
    .slice(0, 6);
  for (const { s, i } of stops) {
    items.push({ icon: 'stop', main: s.name, sub: `Parada · ${routesAtStop(state.net, i).map((r) => r.short).join(', ')}`, act: 'stop', data: i });
  }
  items.push({ icon: 'search', main: `Buscar "${text.trim()}"`, sub: 'Dirección o lugar en el mapa', act: 'geocode', data: text.trim() });
  return items;
}

function renderSuggestions() {
  const box = $('suggestions');
  if (!activeField) { box.hidden = true; return; }
  const items = suggestionsFor($(`${activeField}-input`).value);
  if (!items.length) { box.hidden = true; return; }
  box.innerHTML = items.map((it, k) => `<li><button type="button" data-k="${k}"><span class="s-icon">${ICONS[it.icon]}</span>`
    + `<span><span class="s-main">${esc(it.main)}</span><span class="s-sub">${esc(it.sub)}</span></span></button></li>`).join('');
  box.hidden = false;
  box.items = items;
}

async function chooseSuggestion(it) {
  const which = activeField;
  closeSuggestions();
  if (it.act === 'gps') { setPlace('from', { name: 'Tu ubicación', kind: 'gps', ...(state.me || {}) }); locate(); return; }
  if (it.act === 'recent') { setPlace('from', it.data.from); setPlace('to', it.data.to); search(); return; }
  if (it.act === 'stop') {
    const s = state.net.stops[it.data];
    setPlace(which, { lat: s.lat, lng: s.lng, name: s.name, kind: 'stop' });
  } else if (it.act === 'geocode') {
    toast('Buscando…', 1500);
    const p = await geocode(it.data);
    if (!p) { toast(`No encontré "${it.data}". Prueba con otro nombre o toca el mapa.`); return; }
    setPlace(which, p);
    focusPoint(p);
  }
  if (state.to && state.from) search();
  else if (which === 'to') { $('from-input').focus(); }
}

function closeSuggestions() {
  activeField = null;
  $('suggestions').hidden = true;
  document.activeElement?.blur?.();
}

for (const which of ['from', 'to']) {
  const input = $(`${which}-input`);
  input.addEventListener('focus', () => { activeField = which; input.select(); renderSuggestions(); setSheet('peek'); });
  input.addEventListener('input', () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(renderSuggestions, 80); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const it = $('suggestions').items?.find((x) => x.act !== 'gps'); if (it) chooseSuggestion(it); }
    if (e.key === 'Escape') { closeSuggestions(); if (state[which]) input.value = state[which].name; }
  });
}
$('suggestions').addEventListener('pointerdown', (e) => e.preventDefault()); // que el campo no pierda el foco antes del clic
$('suggestions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (b) chooseSuggestion($('suggestions').items[Number(b.dataset.k)]);
});
document.addEventListener('pointerdown', (e) => {
  if (activeField && !e.target.closest('#search-card')) {
    const which = activeField;
    closeSuggestions();
    if (state[which]) $(`${which}-input`).value = state[which].name;
  }
});

$('swap').addEventListener('click', () => {
  const a = state.from;
  setPlace('from', state.to);
  setPlace('to', a);
  if (state.from && state.to) search();
});

// Nombres de lugares: Google si hay clave; si no, OpenStreetMap (Nominatim).
async function geocode(text) {
  if (state.map.provider === 'google') {
    try {
      const g = new window.google.maps.Geocoder();
      const { results } = await g.geocode({ address: text, region: 'CR', componentRestrictions: { country: 'CR' } });
      if (results[0]) {
        const l = results[0].geometry.location;
        return { lat: l.lat(), lng: l.lng(), name: results[0].formatted_address.replace(/, Costa Rica$/, ''), kind: 'place' };
      }
    } catch { /* sigue con OSM */ }
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cr&accept-language=es&q=${encodeURIComponent(text)}`);
    const [hit] = await res.json();
    if (hit) return { lat: +hit.lat, lng: +hit.lon, name: hit.display_name.split(',').slice(0, 2).join(','), kind: 'place' };
  } catch { /* sin internet */ }
  return null;
}

async function placeName(p) {
  const near = stopsNear(state.net, p, 35)[0];
  if (near) return near.stop.name;
  if (state.map.provider === 'google') {
    try {
      const { results } = await new window.google.maps.Geocoder().geocode({ location: p });
      if (results[0]) return results[0].formatted_address.replace(/, Costa Rica$/, '').split(',').slice(0, 2).join(',');
    } catch { /* sigue */ }
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&accept-language=es&lat=${p.lat}&lon=${p.lng}`);
    const a = (await res.json()).address || {};
    const name = [a.amenity || a.shop || a.building, a.road, a.neighbourhood || a.suburb || a.city_district || a.town || a.city]
      .filter(Boolean).slice(0, 2).join(', ');
    if (name) return name;
  } catch { /* sin internet */ }
  return 'Punto en el mapa';
}

/** Tocar el mapa: elige el destino (o el origen si todavía no hay). */
async function onMapClick(p) {
  if (activeField) { closeSuggestions(); return; }
  const place = { ...p, name: 'Buscando el lugar…', kind: 'place' };
  const which = state.from ? 'to' : 'from';
  setPlace(which, place);
  place.name = await placeName(p);
  if (state[which] === place) $(`${which}-input`).value = place.name;
  if (state.from && state.to) search();
  else toast('Ahora elige a dónde vas: toca el mapa o escribe el destino.');
}

// ---------- Planificar ----------

function whenInfo() {
  const { minute, weekday } = nowInfo();
  if ($('when-mode').value === 'now') return { departAt: minute, weekday, label: 'ahora' };
  const [h, m] = ($('when-time').value || '07:00').split(':').map(Number);
  return { departAt: h * 60 + m, weekday: Number($('when-day').value), label: '' };
}

function initWhen() {
  const { weekday } = nowInfo();
  $('when-day').innerHTML = DAYS.map((d, i) => `<option value="${i}">${i === weekday ? 'Hoy' : i === (weekday + 1) % 7 ? 'Mañana' : d}</option>`).join('');
  $('when-day').value = String(weekday);
  const d = new Date();
  $('when-time').value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

$('when-mode').addEventListener('change', () => {
  const at = $('when-mode').value === 'at';
  $('when-time').hidden = !at;
  $('when-day').hidden = !at;
  search({ keepView: true });
});
$('when-time').addEventListener('change', () => search({ keepView: true }));
$('when-day').addEventListener('change', () => search({ keepView: true }));

let searchSeq = 0;

async function search({ keepView = false } = {}) {
  if (!state.from || !state.to || state.from.lat == null) {
    if (state.from?.kind === 'gps' && state.from.lat == null) toast('Esperando tu ubicación… o toca el mapa para elegir de dónde sales.');
    return;
  }
  const seq = ++searchSeq;
  $('results').innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span>Buscando buses…</div>';
  if (!keepView) showView('results');
  setSheet('half');
  await new Promise((r) => setTimeout(r, 30)); // deja pintar el aviso antes de calcular
  if (seq !== searchSeq) return;
  const { departAt, weekday } = whenInfo();
  state.options = planOptions(state.net, state.from, state.to, { departAt, weekday, count: 4 });
  addRecent();
  renderResults(departAt);
  if (!keepView) showView('results');
  setSheet('half');
  if (state.options.length) drawOptionPreview(state.options[0]);
  else {
    clearTrip();
    drawStops();
    state.map.fitBounds([[state.from.lat, state.from.lng], [state.to.lat, state.to.lng]], mapPad());
  }
}

function drawOptionPreview(o) {
  if (o) drawTrip(o);
}

function legChips(o) {
  return o.legs.map((l) => (l.type === 'bus' ? badge(l.route)
    : `<span title="Caminar">🚶 ${Math.max(1, Math.round(l.minutes))}′</span>`)).join('<span aria-hidden="true">›</span>');
}

const showFare = (o) => (state.senior ? o.seniorFare : o.fare);
const fareText = (o) => (o.fareKnown === false ? (o.fare ? `desde ${formatColones(showFare(o))}` : 'Consultar')
  : state.senior && o.seniorFare === 0 ? 'Gratis' : formatColones(showFare(o)));
const approx = (estimated) => (estimated ? '~' : '');

function gmapsUrl() {
  const ll = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1${state.from?.lat != null ? `&origin=${ll(state.from)}` : ''}&destination=${ll(state.to)}&travelmode=transit`;
}

function renderResults(departAt) {
  const box = $('results');
  if (!state.options.length) {
    const outside = !stopsNear(state.net, state.from, 1500).length || !stopsNear(state.net, state.to, 1500).length;
    box.innerHTML = `<div class="empty"><strong>${outside ? 'Esta zona todavía no tiene rutas en Ruta CR' : 'No hay buses para esa hora'}</strong>`
      + `${outside ? 'No hay rutas cargadas cerca del origen o del destino. ' : 'Prueba con otra hora o día. '}`
      + 'Google Maps puede mostrarte otras opciones.</div>'
      + `<a class="btn primary" href="${esc(gmapsUrl())}" target="_blank" rel="noopener">Ver la ruta en Google Maps</a>`;
    return;
  }
  const fastest = state.options.reduce((a, b) => (b.arrive < a.arrive ? b : a));
  box.innerHTML = state.options.map((o, k) => {
    const fb = o.firstBus;
    const leave = o.leaveAt - departAt;
    return `<button type="button" class="option ${o === fastest ? 'best' : ''}" data-k="${k}">
      ${o === fastest ? '<span class="tag">Llegas primero</span>' : ''}
      <div class="opt-top"><span class="opt-times">${approx(o.estimated)}${formatClock(fb.depart)} → ${approx(o.estimated)}${formatClock(o.arrive)}</span><span class="opt-dur">${formatDuration(o.arrive - o.leaveAt)}</span></div>
      <div class="opt-legs">${legChips(o)}</div>
      <div class="opt-bottom"><span>${leave <= 1 ? '<span class="soon">Sal ya</span>' : `Sal ${formatIn(leave)}`} · ${o.transfers ? `${o.transfers} transbordo` : 'Directo'} · caminas ${formatDistance(o.walkM)}</span>
      <span class="opt-fare">${fareText(o)}</span></div>${o.estimated ? '<div class="small">Hora aproximada: esta ruta no tiene horario oficial cargado.</div>' : ''}
    </button>`;
  }).join('') + `<a class="btn ghost" style="width:100%" href="${esc(gmapsUrl())}" target="_blank" rel="noopener">Comparar en Google Maps</a>`;
}

$('results').addEventListener('click', (e) => {
  const b = e.target.closest('.option');
  if (b) openTrip(state.options[Number(b.dataset.k)]);
});

function openTrip(o) {
  state.selected = o;
  drawTrip(o);
  const { minute } = nowInfo();
  const rows = [];
  for (const l of o.legs) {
    if (l.type === 'walk') {
      rows.push(`<li><span class="t">${formatClock(l.start)}</span><span class="rail walk"><span class="node" style="--rail:var(--muted)"></span></span>`
        + `<span class="what"><strong>Camina ${formatDistance(l.meters)}</strong><span>${formatDuration(l.minutes)} hasta ${esc(l.to.name || 'tu destino')}</span></span></li>`);
    } else {
      const fare = state.senior ? (l.fare || 0) * seniorFactor(l.patternKm) : l.fare;
      rows.push(`<li style="--rail:${esc(l.route.color)}"><span class="t">${approx(l.estimated)}${formatClock(l.depart)}</span><span class="rail"><span class="node"></span></span>`
        + `<span class="what"><strong>${l.from.virtual ? 'Toma el bus en la calle' : esc(l.from.name)}</strong>`
        + `${l.from.virtual ? `<span>${esc(l.from.name)}. Sin parada registrada aquí: hazle la señal al bus.</span>` : ''}`
        + `<span>${badge(l.route)} ${esc(l.route.long)} · hacia ${esc(l.headsign)}</span>`
        + `<span>Viajas ${l.stops} paradas (${formatDuration(l.arrive - l.depart)}) · pasaje ${fare == null ? 'consultar' : fare === 0 ? 'gratis' : formatColones(fare)}</span>`
        + `${l.estimated ? '<span>Hora aproximada (sin horario oficial)</span>' : ''}</span></li>`);
      rows.push(`<li><span class="t">${formatClock(l.arrive)}</span><span class="rail walk"><span class="node" style="--rail:${esc(l.route.color)}"></span></span>`
        + `<span class="what"><strong>Bájate en ${esc(l.to.virtual ? l.to.name.replace(/^Sobre la ruta/, 'la ruta') : l.to.name)}</strong></span></li>`);
    }
  }
  rows.push(`<li><span class="t">${formatClock(o.arrive)}</span><span class="rail"><span class="node" style="--rail:var(--red)"></span></span>`
    + `<span class="what"><strong>Llegas a ${esc(state.to.name)}</strong></span></li>`);
  const leave = o.leaveAt - minute;
  $('trip').innerHTML = `
    <div class="trip-sum">
      <div><small>Sal</small><strong>${formatClock(o.leaveAt)}</strong></div>
      <div><small>Llegas</small><strong>${formatClock(o.arrive)}</strong></div>
      <div><small>Pasaje</small><strong class="money">${fareText(o)}</strong></div>
    </div>
    ${$('when-mode').value === 'now' && leave > 0 && leave < 180 ? `<p class="note">Tienes que salir <strong>${formatIn(leave)}</strong> para alcanzar el bus.</p>` : ''}
    <ol class="timeline">${rows.join('')}</ol>
    <div class="btn-row">
      <button type="button" class="btn primary" id="trip-share">Compartir</button>
      <button type="button" class="btn ghost" id="trip-save">Guardar viaje</button>
      <a class="btn ghost" href="${esc(gmapsUrl())}" target="_blank" rel="noopener">Abrir en Google Maps</a>
    </div>
    ${state.senior ? '<p class="note">Adulto mayor (Ley 7935): gratis en rutas de menos de 25 km, 50 % entre 25 y 50 km, 75 % en más de 50 km. Presenta la cédula o la tarjeta Ciudadano de Oro.</p>' : ''}
    <p class="note warn">${o.estimated ? 'Algunas horas son aproximadas: la ruta viene de OpenStreetMap, sin horario oficial. ' : ''}Tarifas según ARESEP y datos publicados; confirma el pasaje con el chofer.</p>`;
  $('trip-share').addEventListener('click', () => share(o));
  $('trip-save').addEventListener('click', saveFav);
  showView('trip');
  setSheet('half');
}

async function share(o) {
  const text = tripText(o, { from: state.from, to: state.to });
  try {
    if (navigator.share) { await navigator.share({ title: 'Mi viaje en bus', text }); return; }
    await navigator.clipboard.writeText(text);
    toast('Viaje copiado. Pégalo en WhatsApp.');
  } catch { /* cancelado */ }
}

// ---------- Guardados ----------

function addRecent() {
  const r = { from: state.from, to: state.to };
  state.recent = [r, ...state.recent.filter((x) => !(x.to.name === r.to.name && x.from.name === r.from.name))].slice(0, 6);
  save(KEY.recent, state.recent);
  renderSaved();
}

function saveFav() {
  if (!state.from || !state.to) return;
  if (state.favs.some((f) => f.to.name === state.to.name && f.from.name === state.from.name)) { toast('Ya está en Guardados.'); return; }
  state.favs = [{ from: state.from, to: state.to }, ...state.favs].slice(0, 20);
  save(KEY.favs, state.favs);
  renderSaved();
  toast('Guardado. Lo encuentras en la pestaña Guardados.');
}

function renderSaved() {
  const item = (r, i, kind) => `<li><button type="button" class="row-btn" data-${kind}="${i}"><span class="s-icon">${kind === 'fav' ? '★' : ICONS.clock}</span>`
    + `<span class="grow"><span class="name">${esc(r.to.name)}</span><span class="meta">Desde ${esc(r.from.name)}</span></span>`
    + `${kind === 'fav' ? `<span class="chev" data-del="${i}" role="button" aria-label="Quitar">✕</span>` : '<span class="chev">›</span>'}</button></li>`;
  $('tab-guardados').innerHTML = (state.favs.length
    ? `<div class="h3">Guardados</div><ul class="list">${state.favs.map((r, i) => item(r, i, 'fav')).join('')}</ul>`
    : '<div class="empty"><strong>Sin viajes guardados</strong>Busca un viaje y toca "Guardar viaje" para tenerlo a un toque.</div>')
    + (state.recent.length ? `<div class="h3">Recientes</div><ul class="list">${state.recent.map((r, i) => item(r, i, 'rec')).join('')}</ul>` : '');
}

$('tab-guardados').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    state.favs.splice(Number(del.dataset.del), 1);
    save(KEY.favs, state.favs);
    renderSaved();
    return;
  }
  const b = e.target.closest('[data-fav],[data-rec]');
  if (!b) return;
  const r = b.dataset.fav != null ? state.favs[Number(b.dataset.fav)] : state.recent[Number(b.dataset.rec)];
  const from = r.from.kind === 'gps' && state.me ? { ...state.me, name: 'Tu ubicación', kind: 'gps' } : r.from;
  setPlace('from', from);
  setPlace('to', r.to);
  search();
});

// ---------- Cerca de ti ----------

function renderNearby() {
  const center = state.me || (() => { const c = state.map.getCenter(); return { lat: c[0], lng: c[1] }; })();
  const near = stopsNear(state.net, center, state.me ? 1500 : 4000).filter((x) => !x.stop.virtual).slice(0, 6);
  const { minute, weekday } = nowInfo();
  $('home-sub').textContent = state.me ? 'Paradas cerca de ti y el próximo bus.' : 'Toca el mapa o escribe a dónde vas.';
  if (!near.length) {
    $('tab-cerca').innerHTML = '<div class="empty"><strong>No hay paradas cargadas cerca</strong>'
      + 'Mira la pestaña Rutas o busca tu destino para verlo también en Google Maps.</div>';
    return;
  }
  $('tab-cerca').innerHTML = `<ul class="list">${near.map(({ stop, i, meters }) => {
    const next = nextDepartures(state.net, i, { now: minute, weekday, limit: 2 });
    const when = next.length ? next.map((d) => `<span class="dep">${badge(d.route)} <span class="dep-time">${approx(d.estimated)}${formatClock(d.time)}</span></span>`).join('') : '<span class="meta">Sin más buses hoy</span>';
    return `<li><button type="button" class="row-btn" data-stop="${i}"><span class="stop-sign">${stopSvg(34)}</span>`
      + `<span class="grow"><span class="name">${esc(stop.name)}</span><span class="meta">${state.me ? `${formatDistance(meters)} · ` : ''}próximo bus</span><span class="badges">${when}</span></span><span class="chev">›</span></button></li>`;
  }).join('')}</ul>`;
}

$('tab-cerca').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stop]');
  if (b) openStop(Number(b.dataset.stop));
});

// ---------- Parada ----------

function openStop(i) {
  const s = state.net.stops[i];
  const { minute, weekday } = nowInfo();
  const deps = nextDepartures(state.net, i, { now: minute, weekday, limit: 8 });
  const routes = routesAtStop(state.net, i);
  $('stop').innerHTML = `
    <div class="route-head"><span class="stop-sign">${stopSvg(40)}</span><div><strong style="font-size:18px">${esc(s.name)}</strong>
      <div class="badges">${routes.map(badge).join('')}</div></div></div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="stop-to">Ir aquí</button>
      <button type="button" class="btn ghost" id="stop-from">Salir desde aquí</button>
    </div>
    <div class="h3">Próximos buses</div>
    ${deps.length ? `<ul class="list">${deps.map((d) => `<li><div class="row-btn">${badge(d.route)}<span class="grow"><span class="name">Hacia ${esc(d.headsign)}</span>`
      + `<span class="meta">${esc(d.route.long)}</span></span><span style="text-align:right"><span class="dep-time">${approx(d.estimated)}${formatClock(d.time)}</span>`
      + `<span class="meta ${d.time - minute <= 10 ? 'soon' : ''}">${formatIn(d.time - minute)}</span></span></div></li>`).join('')}</ul>`
    : '<div class="empty">No hay más buses hoy en esta parada.</div>'}`;
  $('stop-to').addEventListener('click', () => { setPlace('to', { lat: s.lat, lng: s.lng, name: s.name, kind: 'stop' }); if (state.from) search(); else toast('Elige de dónde sales.'); });
  $('stop-from').addEventListener('click', () => { setPlace('from', { lat: s.lat, lng: s.lng, name: s.name, kind: 'stop' }); if (state.to) search(); else $('to-input').focus(); });
  showView('stop');
  setSheet('half');
  focusPoint(s, 0.0015);
}

// ---------- Rutas ----------

function renderRoutes() {
  $('tab-rutas').innerHTML = `<input id="route-filter" class="search-box" type="search" placeholder="Buscar ruta, número, lugar o empresa" aria-label="Buscar ruta">`
    + '<ul class="list" id="route-list"></ul><p class="small" id="route-count"></p>';
  $('route-filter').addEventListener('input', renderRouteList);
  renderRouteList();
}

function renderRouteList() {
  const q = norm($('route-filter')?.value || '');
  const all = state.net.routes.filter((x) => !q || norm(`${x.short} ${x.long} ${x.desc} ${x.agency}`).includes(q));
  const list = all.slice(0, 80);
  $('route-list').innerHTML = list.map((x) => {
    const prices = Object.values(state.net.fares[x.id] || {});
    const range = prices.length ? `${formatColones(Math.min(...prices))} – ${formatColones(Math.max(...prices))}` : x.fare ? formatColones(x.fare) : '';
    const meta = [x.source === 'osm' ? 'Horario aproximado' : 'Horario oficial', range, x.desc].filter(Boolean).join(' · ');
    return `<li><button type="button" class="row-btn" data-route="${esc(x.id)}">${badge(x)}<span class="grow"><span class="name">${esc(x.long)}</span>`
      + `<span class="meta">${esc(meta)}</span></span><span class="chev">›</span></button></li>`;
  }).join('') || '<li class="empty">No hay rutas con ese nombre.</li>';
  $('route-count').textContent = `${all.length} de ${state.net.routes.length} rutas${all.length > list.length ? ` (se muestran ${list.length}; escribe para filtrar)` : ''}.`;
}

$('tab-rutas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-route]');
  if (b) openRoute(b.dataset.route);
});

function openRoute(id, weekday = nowInfo().weekday) {
  const r = state.net.routes.find((x) => x.id === id);
  const agency = state.net.agencies.find((a) => a.id === r.agency);
  const prices = [...new Set(Object.values(state.net.fares[id] || {}))].sort((a, b) => a - b);
  const names = ['Mínima', 'Media', 'Completa'];
  const tt = routeTimetable(state.net, id, weekday);
  const { minute, weekday: today } = nowInfo();
  const isToday = weekday === today;
  $('route').innerHTML = `
    <div class="route-head">${badge(r)}<strong style="font-size:18px">${esc(r.long)}</strong></div>
    <p class="small">${esc(r.desc)}</p>
    <div class="fare-grid">${prices.map((p, k) => `<div><small>${prices.length === 3 ? names[k] : `Tarifa ${k + 1}`}</small><strong>${formatColones(p)}</strong></div>`).join('')}</div>
    <div class="when"><select id="route-day" aria-label="Día">${DAYS.map((d, i) => `<option value="${i}" ${i === weekday ? 'selected' : ''}>${i === today ? 'Hoy' : d}</option>`).join('')}</select></div>
    ${Object.entries(tt).map(([label, times]) => {
      const next = isToday ? times.find((t) => t >= minute) : null;
      return `<div class="h3">${esc(label)}</div><div class="times">${times.map((t) => `<span class="${isToday && t < minute ? 'past' : ''} ${t === next ? 'next' : ''}">${formatClock(t)}</span>`).join('') || '<span>Sin servicio</span>'}</div>`;
    }).join('') || '<div class="empty">Sin servicio ese día.</div>'}
    ${agency ? `<p class="small">${esc(agency.name)}${agency.phone ? ` · Tel. ${esc(agency.phone)}` : ''}${agency.url ? ` · <a href="${esc(agency.url)}" target="_blank" rel="noopener">Sitio web</a>` : ''}</p>` : ''}
    <p class="note warn">Horarios de salida desde la terminal. Tarifas según los datos de ${esc(state.net.source.version)}; confirma con la empresa.</p>`;
  $('route-day').addEventListener('change', (e) => openRoute(id, Number(e.target.value)));
  if (document.querySelector('#view-route').hidden) { drawRoute(id); showView('route'); setSheet('half'); }
}

// ---------- Pestañas, capas y ajustes ----------

for (const b of document.querySelectorAll('.segmented button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.segmented button')) x.classList.toggle('active', x === b);
    for (const t of ['cerca', 'rutas', 'guardados']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
  });
}

// Selector de mapa: Google (con clave), OpenStreetMap, claro, oscuro o satélite.

function renderStyles() {
  const hasKey = !!googleKey();
  $('style-grid').innerHTML = STYLES.map((s) => {
    const locked = s.provider === 'google' && !hasKey;
    return `<button type="button" class="style-opt ${s.id === state.mapStyle ? 'active' : ''}" data-style="${s.id}" ${locked ? 'data-locked="1"' : ''}>`
      + `<span class="style-prev prev-${s.id}"></span><span class="style-name">${esc(s.name)}</span>`
      + `<span class="style-sub">${locked ? 'Necesita clave' : esc(s.sub)}</span></button>`;
  }).join('');
}

$('layers').addEventListener('click', (e) => {
  e.stopPropagation();
  renderStyles();
  $('styles').hidden = !$('styles').hidden;
});
document.addEventListener('click', (e) => { if (!$('styles').hidden && !e.target.closest('#styles')) $('styles').hidden = true; });

$('style-grid').addEventListener('click', async (e) => {
  e.stopPropagation(); // se vuelve a dibujar la lista: que el clic no cierre el selector
  const b = e.target.closest('[data-style]');
  if (!b) return;
  if (b.dataset.locked) {
    $('styles').hidden = true;
    openSettings();
    toast('Pega tu clave de Google Maps para usar el mapa de Google.', 4000);
    return;
  }
  await setMapStyle(b.dataset.style);
  renderStyles();
});

async function setMapStyle(id) {
  const next = STYLES.find((s) => s.id === id);
  const cur = STYLES.find((s) => s.id === state.mapStyle);
  state.mapStyle = id;
  save(KEY.style, id);
  if (cur && cur.provider === next.provider) state.map.setStyle(id);
  else await buildMap();
  $('layers').classList.toggle('active', id !== 'osm' && id !== 'google-road');
}

/** Crea (o vuelve a crear) el mapa con el estilo elegido y redibuja todo encima. */
async function buildMap() {
  const old = state.map;
  const center = old ? old.getCenter() : CENTER;
  const zoom = old ? old.getZoom() : 12;
  if (old) old.destroy();
  shownStops.clear();
  layers.trip = [];
  layers.route = [];
  layers.pins = {};
  layers.me = null;
  stopMode = '';
  state.map = await createMap($('map'), {
    key: googleKey(),
    style: state.mapStyle,
    center,
    zoom,
    onClick: onMapClick,
    onZoom: onMapMove,
    onMove: onMapMove,
    onFallback: (msg) => { toast(`${msg} Se usa OpenStreetMap.`, 6000); state.mapStyle = 'osm'; },
  });
  if (state.from) setPin('from', state.from);
  if (state.to) setPin('to', state.to);
  if (state.me) setMe(state.me);
  if (!$('view-trip').hidden && state.selected) drawTrip(state.selected, { fit: false });
  else if (!$('view-results').hidden && state.options[0]) drawTrip(state.options[0], { fit: false });
  else if (!$('view-route').hidden && state.routeId) drawRoute(state.routeId, { fit: false });
  else drawStops();
}

function googleKey() {
  return load(KEY.gkey, '') || GOOGLE_MAPS_API_KEY || '';
}

function openSettings() {
  $('set-senior').checked = state.senior;
  $('set-key').value = load(KEY.gkey, '');
  $('map-status').textContent = state.map.provider === 'google'
    ? 'Usando Google Maps.'
    : 'Ahora se usa un mapa gratuito. Con una clave de Google puedes elegir el mapa de Google (normal o satélite) en el botón de capas.';
  const s = state.net.source;
  const osm = state.net.sources.find((x) => x.publisher === 'OpenStreetMap');
  $('data-info').innerHTML = `<strong>Horarios oficiales:</strong> ${esc(state.net.routes.filter((r) => r.source !== 'osm').length)} rutas de Transportes San Gabriel, del GTFS publicado por `
    + `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher)}</a> (Universidad de Costa Rica, ${esc(s.version)}).`
    + (osm ? `<br><strong>Resto del país:</strong> ${osm.routes} rutas y sus paradas de <a href="${esc(osm.url)}" target="_blank" rel="noopener">OpenStreetMap</a> (© colaboradores de OpenStreetMap, ODbL, ${esc(osm.version)}). No traen horario oficial: las horas son aproximadas.` : '')
    + '<br>Las tarifas las fija ARESEP y pueden cambiar.';
  $('settings').hidden = false;
}

$('open-settings').addEventListener('click', openSettings);
$('settings').addEventListener('click', (e) => { if (e.target === $('settings') || e.target.closest('[data-close]')) $('settings').hidden = true; });
$('set-senior').addEventListener('change', () => {
  state.senior = $('set-senior').checked;
  save(KEY.senior, state.senior);
  if (state.options.length) renderResults(whenInfo().departAt);
  if (state.selected && !$('view-trip').hidden) openTrip(state.selected);
});
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('set-key').value.trim();
  save(KEY.gkey, key);
  if (key) save(KEY.style, 'google-road');
  location.reload();
});
$('set-key-clear').addEventListener('click', () => { save(KEY.gkey, ''); save(KEY.style, 'osm'); location.reload(); });

// ---------- Arranque ----------

async function start() {
  // Horarios oficiales (GTFS) + rutas de todo el país de OpenStreetMap, si están.
  const optional = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [gtfs, aresep, osm] = await Promise.all([
    fetch('data/cr-network.json').then((r) => r.json()),
    optional('data/cr-aresep.json'),
    optional('data/cr-osm.json'),
  ]);
  state.net = mergeNetworks(gtfs, aresep, osm);
  state.mapStyle = load(KEY.style, null) || (googleKey() ? 'google-road' : 'osm');
  await buildMap();
  setSheet('half');
  initWhen();
  drawStops();
  renderRoutes();
  renderSaved();
  renderNearby();
  // Al abrir, pedir la ubicación para saber de dónde sales.
  setPlace('from', { name: 'Tu ubicación', kind: 'gps' });
  locate({ quiet: true });
  window.rutaCR = { state, search, setPlace, openStop, openRoute };
}

start();
