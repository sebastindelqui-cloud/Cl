// Interfaz de Mis Buses: mapa (Leaflet + OpenStreetMap), buscador de viajes,
// lista de líneas y editor de rutas. La lógica de rutas está en buses.js.

import {
  planTrip, badgesFor, describeLeg, tripText, discountFactor, monthlyCost, validateNetwork,
  formatMoney, formatDuration, formatDistance, formatClock, parseClock, distanceM, newId, patternsOf,
} from './buses.js';
import { EXAMPLE_NETWORK } from './buses-data.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const KEY = { net: 'misbuses.network', favs: 'misbuses.favs', recent: 'misbuses.recent' };

// ---------- Guardado local ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* modo privado o sin espacio: sigue funcionando sin guardar */ }
}

const clone = (x) => JSON.parse(JSON.stringify(x));
let net = load(KEY.net, null);
if (!net || validateNetwork(net).length) net = clone(EXAMPLE_NETWORK);
let favs = load(KEY.favs, []);
let recent = load(KEY.recent, []);

function saveNet() {
  delete net.example;
  save(KEY.net, net);
  refreshAll();
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Mapa ----------

const map = L.map('map', { zoomControl: true, tap: true }).setView(net.center || [0, 0], net.zoom || 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap',
}).addTo(map);

const networkLayer = L.layerGroup().addTo(map);
const tripLayer = L.layerGroup().addTo(map);
const editLayer = L.layerGroup().addTo(map);
let endMarkers = { from: null, to: null };
let meMarker = null;

function pinIcon(kind) {
  return L.divIcon({
    className: '',
    html: `<div class="end-pin ${kind}"><span>${kind === 'from' ? 'A' : 'B'}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

function stopById(id) {
  return net.stops.find((s) => s.id === id);
}

function drawNetwork(highlightLineId = null) {
  networkLayer.clearLayers();
  const dim = tripLayer.getLayers().length > 0 || highlightLineId;
  for (const line of net.lines) {
    const pts = line.stops.map(stopById).filter(Boolean).map((s) => [s.lat, s.lng]);
    if (line.circular && pts.length > 2) pts.push(pts[0]);
    const on = !highlightLineId || highlightLineId === line.id;
    L.polyline(pts, { color: line.color, weight: on && highlightLineId ? 7 : 4, opacity: dim && !(highlightLineId && on) ? 0.25 : 0.85 })
      .bindTooltip(line.name, { sticky: true })
      .on('click', () => { if (!pickMode) showLineOnMap(line.id); })
      .addTo(networkLayer);
  }
  const lineNames = new Map();
  for (const line of net.lines) for (const id of line.stops) {
    if (!lineNames.has(id)) lineNames.set(id, []);
    lineNames.get(id).push(line.name);
  }
  for (const s of net.stops) {
    L.circleMarker([s.lat, s.lng], { radius: 5, color: '#fff', weight: 2, fillColor: '#334', fillOpacity: dim ? 0.4 : 1 })
      .bindPopup(`<strong>${escapeHtml(s.name)}</strong><br><small>${escapeHtml((lineNames.get(s.id) || []).join(', ') || 'Sin líneas')}</small>`
        + `<br><button type="button" data-go-from="${escapeHtml(s.id)}">Salir de aquí</button> <button type="button" data-go-to="${escapeHtml(s.id)}">Ir aquí</button>`)
      .addTo(networkLayer);
  }
}

// Botones dentro de las ventanitas de las paradas.
map.on('popupopen', (e) => {
  const el = e.popup.getElement();
  el.querySelector('[data-go-from]')?.addEventListener('click', (ev) => {
    setPlace('from', stopPlace(stopById(ev.target.dataset.goFrom)));
    map.closePopup();
  });
  el.querySelector('[data-go-to]')?.addEventListener('click', (ev) => {
    setPlace('to', stopPlace(stopById(ev.target.dataset.goTo)));
    map.closePopup();
    if (places.from) search();
  });
});

function fitNetwork() {
  const pts = net.stops.map((s) => [s.lat, s.lng]);
  if (pts.length > 1) map.fitBounds(pts, { padding: [20, 20] });
  else if (net.center) map.setView(net.center, net.zoom || 13);
}

// ---------- Origen y destino ----------

const places = { from: null, to: null };
const stopPlace = (s) => ({ lat: s.lat, lng: s.lng, name: s.name });

function setPlace(which, place) {
  places[which] = place;
  $(`${which}-input`).value = place ? place.name : '';
  if (endMarkers[which]) endMarkers[which].remove();
  endMarkers[which] = place ? L.marker([place.lat, place.lng], { icon: pinIcon(which), zIndexOffset: 1000 }).addTo(map) : null;
}

function refreshStopList() {
  const names = [...new Set(net.stops.map((s) => s.name))].sort((a, b) => a.localeCompare(b, 'es'));
  $('stop-list').innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Convierte lo escrito en un punto: parada, "lat, lng" o dirección (OpenStreetMap). */
async function resolveInput(which) {
  const text = $(`${which}-input`).value.trim();
  if (!text) return null;
  if (places[which] && places[which].name === text) return places[which];
  const exact = net.stops.find((s) => norm(s.name) === norm(text));
  if (exact) return stopPlace(exact);
  const coords = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (coords) return { lat: Number(coords[1]), lng: Number(coords[2]), name: text };
  const partial = net.stops.find((s) => norm(s.name).includes(norm(text)));
  if (partial) return stopPlace(partial);
  return geocode(text);
}

async function geocode(text) {
  try {
    const b = map.getBounds().pad(1.5);
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=es&q=${encodeURIComponent(text)}`
      + `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}&bounded=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const [hit] = await res.json();
    if (!hit) return null;
    return { lat: Number(hit.lat), lng: Number(hit.lon), name: text };
  } catch {
    return null;
  }
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Tu navegador no permite ubicación.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, name: 'Mi ubicación' }),
      () => reject(new Error('No se pudo obtener tu ubicación. Revisa que la página tenga permiso.')),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}

async function useGps(which) {
  msg('Buscando tu ubicación…');
  try {
    const p = await locate();
    setPlace(which, p);
    if (meMarker) meMarker.remove();
    meMarker = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }) }).addTo(map);
    map.setView([p.lat, p.lng], 15);
    const near = net.stops.map((s) => ({ s, d: distanceM(p, s) })).sort((a, b) => a.d - b.d)[0];
    msg(near ? `Parada más cercana: ${near.s.name} (${formatDistance(near.d)}).` : '');
  } catch (e) {
    msg(e.message);
  }
}

// ---------- Elegir en el mapa ----------

let pickMode = null; // 'from' | 'to' | 'edit'

function startPick(mode, text) {
  pickMode = mode;
  $('pick-text').textContent = text;
  $('pick-banner').hidden = false;
  $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function endPick() {
  pickMode = null;
  $('pick-banner').hidden = true;
}

map.on('click', (e) => {
  const p = { lat: e.latlng.lat, lng: e.latlng.lng };
  if (pickMode === 'from' || pickMode === 'to') {
    const near = net.stops.find((s) => distanceM(p, s) < 40);
    setPlace(pickMode, near ? stopPlace(near) : { ...p, name: `Punto en el mapa (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})` });
    const was = pickMode;
    endPick();
    if (was === 'to' && places.from) search();
  } else if (pickMode === 'edit') {
    addStopToDraft(p);
  }
});

$('pick-cancel').addEventListener('click', endPick);

// ---------- Buscar ----------

let lastOptions = [];
let selected = null;

function msg(text) {
  $('search-msg').textContent = text;
}

function departMinute() {
  if ($('depart-mode').value === 'at') return parseClock($('depart-time').value) ?? 480;
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function settings() {
  return {
    passengers: Math.max(1, Math.min(20, Number($('passengers').value) || 1)),
    profile: $('profile').value,
  };
}

async function search() {
  msg('Buscando…');
  const [from, to] = await Promise.all([resolveInput('from'), resolveInput('to')]);
  if (!from) { msg('No encontré el origen. Escribe una parada, una dirección o elígelo en el mapa.'); return; }
  if (!to) { msg('No encontré el destino. Escribe una parada, una dirección o elígelo en el mapa.'); return; }
  setPlace('from', from);
  setPlace('to', to);
  const departAt = departMinute();
  lastOptions = planTrip(net, from, to, { departAt });
  addRecent(from, to);
  renderResults(departAt);
  if (!lastOptions.length) {
    msg('No hay buses que conecten estos puntos con tus rutas. Prueba otro punto cercano o agrega la línea en ✏️ Mis rutas.');
    tripLayer.clearLayers();
    drawNetwork();
    map.fitBounds([[from.lat, from.lng], [to.lat, to.lng]], { padding: [40, 40] });
    return;
  }
  msg('');
  selectOption(lastOptions[0]);
}

function renderResults(departAt) {
  const box = $('results');
  box.innerHTML = '';
  const { passengers, profile } = settings();
  const factor = discountFactor(net, profile);
  const badges = badgesFor(lastOptions);
  for (const o of lastOptions) {
    const card = document.createElement('article');
    card.className = 'card option';
    const total = o.fare * factor * passengers;
    const chips = o.legs.map((l) => (l.type === 'bus'
      ? `<span class="chip" style="background:${escapeHtml(l.line.color)}">${escapeHtml(l.line.name)}</span>`
      : (l.meters > 60 ? `<span class="chip walk">🚶 ${Math.round(l.minutes)}′</span>` : ''))).filter(Boolean).join(' › ');
    const steps = o.legs.filter((l) => l.type === 'bus' || l.meters > 30).map((l) => {
      let extra = '';
      if (l.type === 'bus') {
        extra += `<span class="hint">Espera ~${Math.round(l.waitMin)} min · pasaje ${escapeHtml(formatMoney(l.fare * factor, net.currency))}</span>`;
        if (l.notRunning) extra += `<span class="warn-text">⚠️ Puede que no esté funcionando a esa hora (${escapeHtml(l.line.firstBus)}–${escapeHtml(l.line.lastBus)}).</span>`;
      }
      return `<li>${escapeHtml(describeLeg(l))}${extra ? `<br>${extra}` : ''}</li>`;
    }).join('');
    const sub = o.buses === 0
      ? `Caminando · ${formatDistance(o.walkM)}`
      : `${o.transfers === 0 ? 'Directo' : `${o.transfers} transbordo${o.transfers > 1 ? 's' : ''}`} · camina ${formatDistance(o.walkM)}`;
    card.innerHTML = `
      <div>${badges.get(o).map((b) => `<span class="badge">${b}</span>`).join('')}</div>
      <div class="option-head">
        <span class="option-time">${formatDuration(o.time)}</span>
        <span class="hint">llegas ~${formatClock(departAt + o.time)}</span>
        <span class="option-fare">${o.buses === 0 ? 'Gratis' : escapeHtml(formatMoney(total, net.currency))}</span>
      </div>
      <div class="option-sub">${sub}${passengers > 1 && o.buses ? ` · ${passengers} personas` : ''}${factor < 1 && o.buses ? ' · con descuento' : ''}</div>
      <div class="chips">${chips}</div>
      <ol class="steps" hidden>${steps}</ol>
      <div class="option-actions">
        <button type="button" data-act="share">📤 Compartir</button>
        <button type="button" data-act="fav">⭐ Guardar</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'share') shareOption(o, departAt);
      else if (act === 'fav') addFav();
      else selectOption(o);
    });
    o.card = card;
    box.append(card);
  }
}

function selectOption(o) {
  selected = o;
  for (const x of lastOptions) {
    x.card?.classList.toggle('selected', x === o);
    const steps = x.card?.querySelector('.steps');
    if (steps) steps.hidden = x !== o;
  }
  drawTrip(o);
  updateMonthly();
}

function drawTrip(o) {
  tripLayer.clearLayers();
  const bounds = [];
  for (const leg of o.legs) {
    if (leg.type === 'walk') {
      const pts = [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]];
      L.polyline(pts, { color: '#555', weight: 4, dashArray: '2 8', opacity: 0.9 }).addTo(tripLayer);
      bounds.push(...pts);
      continue;
    }
    const pattern = patternsOf(leg.line).find((p) => p.towards === leg.towards) || patternsOf(leg.line)[0];
    const a = pattern.ids.indexOf(leg.from.id);
    let ids = pattern.ids.slice(a);
    ids = ids.slice(0, ids.indexOf(leg.to.id, 1) + 1);
    const pts = ids.map(stopById).filter(Boolean).map((s) => [s.lat, s.lng]);
    L.polyline(pts, { color: '#fff', weight: 10, opacity: 0.9 }).addTo(tripLayer);
    L.polyline(pts, { color: leg.line.color, weight: 6 }).bindTooltip(leg.line.name).addTo(tripLayer);
    for (const [i, p] of pts.entries()) {
      const s = stopById(ids[i]);
      const isEnd = i === 0 || i === pts.length - 1;
      L.circleMarker(p, { radius: isEnd ? 7 : 4, color: '#fff', weight: 2, fillColor: leg.line.color, fillOpacity: 1 })
        .bindTooltip(`${i === 0 ? 'Sube: ' : isEnd ? 'Baja: ' : ''}${s.name}`, { permanent: isEnd, direction: 'top', offset: [0, -6] })
        .addTo(tripLayer);
    }
    bounds.push(...pts);
  }
  drawNetwork();
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
}

async function shareOption(o, departAt) {
  const { passengers, profile } = settings();
  const text = tripText(o, net, { from: places.from, to: places.to, departAt, passengers, profile });
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    msg('Viaje copiado. Pégalo en WhatsApp o donde quieras.');
  } catch { /* el usuario canceló */ }
}

function updateMonthly() {
  const box = $('monthly');
  if (!selected || selected.buses === 0) { box.hidden = true; return; }
  box.hidden = false;
  const { profile } = settings();
  const fare = selected.fare * discountFactor(net, profile);
  const trips = Number($('m-trips').value) || 1;
  const days = Number($('m-days').value) || 1;
  $('m-total').textContent = formatMoney(Math.round(monthlyCost(fare, trips, days)), net.currency);
  $('m-detail').textContent = `${formatMoney(fare, net.currency)} por viaje × ${trips} al día × ${days} días por semana. `
    + `Por semana: ${formatMoney(fare * trips * days, net.currency)}.`;
}

// ---------- Guardados y recientes ----------

function addRecent(from, to) {
  recent = [{ from, to }, ...recent.filter((r) => !(r.from.name === from.name && r.to.name === to.name))].slice(0, 5);
  save(KEY.recent, recent);
  renderSaved();
}

function addFav() {
  if (!places.from || !places.to) return;
  const label = prompt('Nombre para este viaje (ej.: Casa → Trabajo):', `${places.from.name} → ${places.to.name}`);
  if (!label) return;
  favs = [{ label, from: places.from, to: places.to }, ...favs].slice(0, 20);
  save(KEY.favs, favs);
  renderSaved();
}

function renderSaved() {
  const item = (r, i, kind) => `<li><button type="button" class="grow" data-${kind}="${i}">${escapeHtml(r.label || `${r.from.name} → ${r.to.name}`)}</button>`
    + `${kind === 'fav' ? `<button type="button" class="small del" data-del-fav="${i}" aria-label="Borrar">✕</button>` : ''}</li>`;
  $('favs').innerHTML = favs.map((r, i) => item(r, i, 'fav')).join('');
  $('favs-empty').hidden = favs.length > 0;
  $('recent').innerHTML = recent.map((r, i) => item(r, i, 'rec')).join('') || '<li class="hint">Todavía nada.</li>';
}

function runSaved(r) {
  setPlace('from', r.from);
  setPlace('to', r.to);
  search();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('favs').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del-fav]');
  if (del) {
    favs.splice(Number(del.dataset.delFav), 1);
    save(KEY.favs, favs);
    renderSaved();
    return;
  }
  const b = e.target.closest('[data-fav]');
  if (b) runSaved(favs[Number(b.dataset.fav)]);
});

$('recent').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rec]');
  if (b) runSaved(recent[Number(b.dataset.rec)]);
});

// ---------- Líneas ----------

function renderLines() {
  const q = norm($('line-filter').value);
  const box = $('line-list');
  const t = net.transfer || {};
  const transferText = t.policy === 'free' ? 'Transbordo gratis' : t.policy === 'fixed'
    ? `Transbordo: ${formatMoney(t.amount || 0, net.currency)}` : 'Cada bus se paga completo';
  const list = net.lines.filter((l) => !q || norm(l.name).includes(q)
    || l.stops.some((id) => norm(stopById(id)?.name || '').includes(q)));
  box.innerHTML = list.length ? '' : '<p class="hint">No hay líneas que coincidan. Agrégalas en ✏️ Mis rutas.</p>';
  for (const l of list) {
    const card = document.createElement('article');
    card.className = 'card line-card option';
    const names = l.stops.map((id) => stopById(id)?.name || '?');
    card.innerHTML = `
      <h3><span class="swatch" style="background:${escapeHtml(l.color)}"></span>${escapeHtml(l.name)}</h3>
      <div class="hint">${escapeHtml(l.start || names[0])} ⇄ ${escapeHtml(l.circular ? '(circular)' : l.end || names.at(-1))}</div>
      <div class="line-meta">
        <span>Pasaje <strong>${escapeHtml(formatMoney(l.fare, net.currency))}</strong></span>
        <span>Pasa cada <strong>${l.headwayMin || 10} min</strong></span>
        <span>Horario <strong>${escapeHtml(l.firstBus || '?')}–${escapeHtml(l.lastBus || '?')}</strong></span>
        <span><strong>${l.stops.length}</strong> paradas</span>
      </div>
      <p class="line-stops">${names.map(escapeHtml).join(' · ')}</p>`;
    card.addEventListener('click', () => showLineOnMap(l.id));
    box.append(card);
  }
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = `${transferText}${t.windowMin ? ` (dentro de ${t.windowMin} min)` : ''}. Descuentos: estudiante ${net.discounts?.estudiante || 0}%, adulto mayor ${net.discounts?.mayor || 0}%.`;
  box.append(note);
}

function showLineOnMap(id) {
  tripLayer.clearLayers();
  drawNetwork(id);
  const line = net.lines.find((l) => l.id === id);
  const pts = line.stops.map(stopById).filter(Boolean).map((s) => [s.lat, s.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [30, 30] });
  $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('line-filter').addEventListener('input', renderLines);

// ---------- Editor ----------

let draft = null; // línea que se está editando

function renderEditor() {
  $('e-net-name').value = net.name || '';
  $('e-currency').value = net.currency || '$';
  const t = net.transfer || { policy: 'full' };
  $('e-transfer').value = t.policy;
  $('e-transfer-amount').value = t.amount ?? '';
  $('e-transfer-window').value = t.windowMin ?? '';
  $('e-disc-est').value = net.discounts?.estudiante ?? 0;
  $('e-disc-may').value = net.discounts?.mayor ?? 0;
  syncTransferFields();
  $('e-lines').innerHTML = net.lines.map((l, i) => `<li><span class="swatch" style="background:${escapeHtml(l.color)}"></span>`
    + `<button type="button" class="grow" data-edit="${i}">${escapeHtml(l.name)} <small class="hint">· ${escapeHtml(formatMoney(l.fare, net.currency))} · ${l.stops.length} paradas</small></button>`
    + `<button type="button" class="small del" data-del="${i}" aria-label="Borrar ${escapeHtml(l.name)}">✕</button></li>`).join('')
    || '<li class="hint">Todavía no hay líneas.</li>';
}

function syncTransferFields() {
  const p = $('e-transfer').value;
  $('e-transfer-amount-wrap').hidden = p !== 'fixed';
  $('e-transfer-window-wrap').hidden = p === 'full';
}

function saveSettings() {
  net.name = $('e-net-name').value.trim() || 'Mi ciudad';
  net.currency = $('e-currency').value.trim() || '$';
  const amount = Number($('e-transfer-amount').value);
  const windowMin = $('e-transfer-window').value === '' ? null : Number($('e-transfer-window').value);
  net.transfer = { policy: $('e-transfer').value, amount: Number.isFinite(amount) ? amount : 0, windowMin };
  net.discounts = { estudiante: Number($('e-disc-est').value) || 0, mayor: Number($('e-disc-may').value) || 0 };
  syncTransferFields();
  saveNet();
}

for (const id of ['e-net-name', 'e-currency', 'e-transfer', 'e-transfer-amount', 'e-transfer-window', 'e-disc-est', 'e-disc-may']) {
  $(id).addEventListener('change', saveSettings);
}

$('e-center').addEventListener('click', () => {
  const c = map.getCenter();
  net.center = [c.lat, c.lng];
  net.zoom = map.getZoom();
  saveNet();
  $('e-io-msg').textContent = 'Listo: el mapa abrirá aquí.';
});

function openLineForm(line) {
  draft = line ? clone(line) : {
    id: newId('l'), name: '', color: randomColor(), fare: '', headwayMin: 10, speedKmh: 18,
    firstBus: '05:30', lastBus: '22:00', stops: [], circular: false, oneWay: false, isNew: true,
  };
  draft.newStops = [];
  $('e-line-title').textContent = line ? `Editar ${line.name}` : 'Nueva línea';
  $('e-name').value = draft.name;
  $('e-color').value = draft.color;
  $('e-fare').value = draft.fare;
  $('e-headway').value = draft.headwayMin;
  $('e-speed').value = draft.speedKmh;
  $('e-first').value = draft.firstBus || '';
  $('e-last').value = draft.lastBus || '';
  $('e-circular').checked = !!draft.circular;
  $('e-oneway').checked = !!draft.oneWay;
  $('e-line-msg').textContent = '';
  $('e-line-form').hidden = false;
  renderDraftStops();
  $('e-line-form').scrollIntoView({ behavior: 'smooth' });
}

function randomColor() {
  const colors = ['#e63946', '#1d6fdc', '#2a9d8f', '#f4a261', '#8e44ad', '#16a085', '#d35400', '#c0392b', '#2c3e50', '#e84393'];
  return colors[net.lines.length % colors.length];
}

function draftStop(id) {
  return draft.newStops.find((s) => s.id === id) || stopById(id);
}

function renderDraftStops() {
  $('e-stops').innerHTML = draft.stops.map((id, i) => `<li><span>${escapeHtml(draftStop(id)?.name || '?')}</span>`
    + `<button type="button" data-up="${i}" aria-label="Subir">↑</button>`
    + `<button type="button" data-down="${i}" aria-label="Bajar">↓</button>`
    + `<button type="button" class="del" data-rm="${i}" aria-label="Quitar">✕</button></li>`).join('');
  editLayer.clearLayers();
  const pts = draft.stops.map(draftStop).filter(Boolean).map((s) => [s.lat, s.lng]);
  if (pts.length) {
    L.polyline(pts, { color: $('e-color').value, weight: 5, dashArray: '6 6' }).addTo(editLayer);
    pts.forEach((p, i) => L.circleMarker(p, { radius: 7, color: '#fff', weight: 2, fillColor: $('e-color').value, fillOpacity: 1 })
      .bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: '' }).addTo(editLayer));
  }
}

function addStopToDraft(p) {
  if (!draft) return;
  const all = [...net.stops, ...draft.newStops];
  const near = all.map((s) => ({ s, d: distanceM(p, s) })).filter((x) => x.d < 60).sort((a, b) => a.d - b.d)[0];
  let stop = near?.s;
  if (!stop) {
    const name = prompt('Nombre de esta parada:', `Parada ${all.length + 1}`);
    if (!name) return;
    stop = { id: newId('s'), name: name.trim(), lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) };
    draft.newStops.push(stop);
  }
  draft.stops.push(stop.id);
  renderDraftStops();
  $('pick-text').textContent = `${draft.stops.length} paradas. Sigue tocando el mapa, o toca Listo.`;
}

$('e-stops').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const s = draft.stops;
  if (b.dataset.rm != null) s.splice(Number(b.dataset.rm), 1);
  if (b.dataset.up != null) { const i = Number(b.dataset.up); if (i > 0) [s[i - 1], s[i]] = [s[i], s[i - 1]]; }
  if (b.dataset.down != null) { const i = Number(b.dataset.down); if (i < s.length - 1) [s[i + 1], s[i]] = [s[i], s[i + 1]]; }
  renderDraftStops();
});

$('e-color').addEventListener('input', () => draft && renderDraftStops());
$('e-new-line').addEventListener('click', () => openLineForm(null));
$('e-add-stops').addEventListener('click', () => startPick('edit', 'Toca el mapa en cada parada, en orden.'));

$('e-lines').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { openLineForm(net.lines[Number(edit.dataset.edit)]); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    const line = net.lines[Number(del.dataset.del)];
    if (!confirm(`¿Borrar ${line.name}?`)) return;
    net.lines.splice(Number(del.dataset.del), 1);
    pruneStops();
    saveNet();
  }
});

function closeLineForm() {
  draft = null;
  $('e-line-form').hidden = true;
  editLayer.clearLayers();
  endPick();
}

$('e-cancel-line').addEventListener('click', closeLineForm);

$('e-save-line').addEventListener('click', () => {
  const name = $('e-name').value.trim();
  const fare = Number($('e-fare').value);
  const err = !name ? 'Ponle un nombre a la línea.'
    : !($('e-fare').value !== '' && fare >= 0) ? 'Escribe cuánto cuesta el pasaje.'
      : draft.stops.length < 2 ? 'Agrega al menos 2 paradas tocando el mapa.' : '';
  if (err) { $('e-line-msg').textContent = err; return; }
  const used = new Set(draft.stops);
  net.stops.push(...draft.newStops.filter((s) => used.has(s.id)));
  const names = draft.stops.map((id) => stopById(id).name);
  const line = {
    id: draft.id, name, color: $('e-color').value, fare,
    headwayMin: Math.max(1, Number($('e-headway').value) || 10),
    speedKmh: Math.max(5, Number($('e-speed').value) || 18),
    firstBus: $('e-first').value, lastBus: $('e-last').value,
    circular: $('e-circular').checked, oneWay: $('e-oneway').checked,
    start: names[0], end: names.at(-1), stops: [...draft.stops],
  };
  const i = net.lines.findIndex((l) => l.id === line.id);
  if (i >= 0) net.lines[i] = line; else net.lines.push(line);
  pruneStops();
  closeLineForm();
  saveNet();
});

/** Borra paradas que ya no usa ninguna línea. */
function pruneStops() {
  const used = new Set(net.lines.flatMap((l) => l.stops));
  net.stops = net.stops.filter((s) => used.has(s.id));
}

$('e-export').addEventListener('click', () => {
  const data = { ...net };
  delete data.example;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mis-buses-${norm(net.name || 'rutas').replace(/[^a-z0-9]+/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('e-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const errors = validateNetwork(data);
    if (errors.length) { $('e-io-msg').textContent = `No se pudo importar: ${errors.slice(0, 3).join(' ')}`; return; }
    net = data;
    saveNet();
    fitNetwork();
    $('e-io-msg').textContent = `Importadas ${net.lines.length} líneas y ${net.stops.length} paradas.`;
  } catch {
    $('e-io-msg').textContent = 'El archivo no es válido.';
  }
});

$('e-clear').addEventListener('click', () => {
  if (!confirm('¿Borrar todas las líneas y paradas? (Descarga un respaldo antes si las quieres guardar.)')) return;
  const c = map.getCenter();
  net = {
    name: 'Mi ciudad', currency: net.currency || '$', center: [c.lat, c.lng], zoom: map.getZoom(),
    transfer: { policy: 'full', amount: 0, windowMin: null }, discounts: { estudiante: 0, mayor: 0 }, stops: [], lines: [],
  };
  saveNet();
});

$('e-example').addEventListener('click', () => {
  if (!confirm('¿Reemplazar tus rutas por la red de ejemplo?')) return;
  net = clone(EXAMPLE_NETWORK);
  try { localStorage.removeItem(KEY.net); } catch { /* nada */ }
  refreshAll();
  fitNetwork();
});

// ---------- Pestañas y arranque ----------

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of ['viajar', 'lineas', 'editar']) $(`tab-${t}`).hidden = t !== name;
  if (name !== 'editar' && pickMode === 'edit') endPick();
  if (name === 'lineas') renderLines();
}

for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

function refreshAll() {
  $('net-name').textContent = net.name || '';
  $('example-note').hidden = !net.example;
  refreshStopList();
  tripLayer.clearLayers();
  $('results').innerHTML = '';
  $('monthly').hidden = true;
  lastOptions = [];
  selected = null;
  drawNetwork();
  renderEditor();
  renderLines();
  renderSaved();
}

$('from-gps').addEventListener('click', () => useGps('from'));
$('to-gps').addEventListener('click', () => useGps('to'));
$('from-map').addEventListener('click', () => startPick('from', 'Toca el mapa donde sales (A).'));
$('to-map').addEventListener('click', () => startPick('to', 'Toca el mapa a donde vas (B).'));
$('swap').addEventListener('click', () => {
  const a = places.from;
  const aText = $('from-input').value;
  const bText = $('to-input').value;
  setPlace('from', places.to);
  setPlace('to', a);
  $('from-input').value = bText;
  $('to-input').value = aText;
});
for (const w of ['from', 'to']) {
  $(`${w}-input`).addEventListener('change', () => {
    if (places[w] && places[w].name !== $(`${w}-input`).value) places[w] = null;
  });
  $(`${w}-input`).addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
}
$('search').addEventListener('click', search);
$('depart-mode').addEventListener('change', () => { $('depart-time-wrap').hidden = $('depart-mode').value !== 'at'; });
for (const id of ['passengers', 'profile']) {
  $(id).addEventListener('change', () => {
    if (!lastOptions.length) return;
    const sel = selected;
    renderResults(departMinute());
    selectOption(sel && lastOptions.includes(sel) ? sel : lastOptions[0]);
  });
}
for (const id of ['m-trips', 'm-days']) $(id).addEventListener('input', updateMonthly);

refreshAll();
if (!load(KEY.net, null)?.center) fitNetwork();

// Para las pruebas automáticas.
window.misBuses = { get net() { return net; }, get options() { return lastOptions; }, map };
