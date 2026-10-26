// Convierte los ramales de autobús de ARESEP (capa PR05_Vista_BusRamales, del
// levantamiento GPS de rutas de todo el país) al formato de la app.
//
//   node tools/aresep-to-network.mjs ramales.geojson.gz data/cr-osm.json data/cr-aresep.json
//
// Cada ramal trae su código del CTP, la empresa y el trazado, pero no paradas
// ni horarios. Como paradas se usan las de OpenStreetMap que quedan a menos de
// 35 m del trazado; donde no hay ninguna en 800 m se agrega un punto "sobre la
// ruta" para poder subirse. Las horas son aproximadas (frecuencia estimada).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chainWays } from './osm-to-network.mjs';

const PALETTE = ['#1a56c4', '#d93025', '#188038', '#e37400', '#8430ce', '#00897b', '#c2185b', '#5d4037', '#3949ab', '#7cb342'];
const SNAP_M = 35;
const GAP_KM = 0.8;

const readJson = (file) => {
  const buf = fs.readFileSync(file);
  return JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8'));
};

function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let idx = -1;
    const [ax, ay] = points[a];
    const dx = points[b][0] - ax;
    const dy = points[b][1] - ay;
    const len = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i += 1) {
      const t = Math.max(0, Math.min(1, ((points[i][0] - ax) * dx + (points[i][1] - ay) * dy) / len));
      const d = Math.hypot(points[i][0] - (ax + t * dx), points[i][1] - (ay + t * dy));
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const title = (s) => String(s || '').trim().toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(De|Del|La|Las|Los|Y|Por|El|A|En)\b/g, (w) => w.toLowerCase());
const pick = (p, ...names) => {
  for (const n of names) {
    const k = Object.keys(p).find((x) => x.toUpperCase() === n);
    if (k && p[k] != null && String(p[k]).trim() !== '') return String(p[k]).trim();
  }
  return '';
};

/** Distancia (m) de un punto a un segmento, en coordenadas planas locales. */
function pointSegM(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180) * 111_320;
  const ax = (a[1] - p[1]) * k; const ay = (a[0] - p[0]) * 110_540;
  const bx = (b[1] - p[1]) * k; const by = (b[0] - p[0]) * 110_540;
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-9)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function convertAresep(geojson, osmNet) {
  // Paradas reales de OpenStreetMap en una cuadrícula para buscarlas rápido.
  const real = (osmNet?.stops || []).filter((s) => !s.virtual);
  const grid = new Map();
  const key = (lat, lng) => `${Math.floor(lat / 0.005)}:${Math.floor(lng / 0.005)}`;
  real.forEach((s, i) => { const k = key(s.lat, s.lng); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });

  const stops = [];
  const stopIdx = new Map();
  const useReal = (i) => {
    const k = `r${i}`;
    if (!stopIdx.has(k)) { stopIdx.set(k, stops.length); const s = real[i]; stops.push({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, zone: null }); }
    return stopIdx.get(k);
  };
  const addVirtual = (p, name) => { stops.push({ id: `a${stops.length}`, name, lat: +p[0].toFixed(6), lng: +p[1].toFixed(6), zone: null, virtual: true }); return stops.length - 1; };

  const routes = new Map();
  const patterns = [];
  let n = 0;
  for (const f of geojson.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const parts = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
    const line = chainWays(parts.map((part) => part.map(([lng, lat]) => [lat, lng])));
    if (line.length < 2) continue;
    const p = f.properties || {};
    const code = pick(p, 'CODCTP2019', 'CODIGO', 'COD_RUTA', 'RUTA');
    const name = title(pick(p, 'RUTACTP2019', 'NOMBRE', 'DESCRIPCION', 'RAMAL'));
    const operator = title(pick(p, 'OPERADOR', 'EMPRESA'));
    const fare = Number(pick(p, 'TARIFA', 'TARIFA_REGULAR', 'TARIFA_GENERAL').replace(',', '.')) || null;
    const routeKey = code || name || `r${n}`;
    if (!routes.has(routeKey)) {
      routes.set(routeKey, {
        id: `ar${routes.size}`, agency: operator, short: code ? code.replace(/^0+(?=\d)/, '') : 'Bus', long: name || `Ruta ${code}`,
        desc: [operator, pick(p, 'CANTONINICIO') && `${title(pick(p, 'CANTONINICIO'))} – ${title(pick(p, 'CANTONFINAL'))}`].filter(Boolean).join(' · '),
        color: PALETTE[routes.size % PALETTE.length], text: '#ffffff', url: '', fare, source: 'aresep',
      });
    }
    const route = routes.get(routeKey);
    if (!route.fare && fare) route.fare = fare;

    // Paradas reales cerca del trazado, en el orden del recorrido.
    const cand = new Set();
    for (const q of line) {
      const cy = Math.floor(q[0] / 0.005); const cx = Math.floor(q[1] / 0.005);
      for (let y = cy - 1; y <= cy + 1; y += 1) for (let x = cx - 1; x <= cx + 1; x += 1) for (const i of grid.get(`${y}:${x}`) || []) cand.add(i);
    }
    const near = [];
    for (const i of cand) {
      const s = [real[i].lat, real[i].lng];
      let best = Infinity;
      for (let k = 1; k < line.length; k += 1) { const d = pointSegM(s, line[k - 1], line[k]); if (d < best) best = d; if (best < 5) break; }
      if (best <= SNAP_M) near.push(i);
    }
    // Posición de cada parada a lo largo del trazado (km desde el inicio).
    const cum = [0];
    for (let k = 1; k < line.length; k += 1) cum.push(cum[k - 1] + haversineKm(line[k - 1], line[k]));
    const posOf = (pt) => { let bi = 0; let bd = Infinity; line.forEach((q, k) => { const d = (q[0] - pt[0]) ** 2 + (q[1] - pt[1]) ** 2; if (d < bd) { bd = d; bi = k; } }); return cum[bi]; };
    const placed = near.map((i) => ({ km: posOf([real[i].lat, real[i].lng]), idx: useReal(i) })).sort((a, b) => a.km - b.km);
    const total = cum.at(-1);
    // Puntos "sobre la ruta" donde no hay paradas (y en los extremos).
    const seq = [];
    let last = null;
    const pushVirtual = (km) => {
      const k = cum.findIndex((c) => c >= km);
      seq.push({ km, idx: addVirtual(line[k < 0 ? line.length - 1 : k], `Sobre la ruta ${route.short} · km ${km.toFixed(1).replace(".", ",")}`) });
      last = km;
    };
    if (!placed.length || placed[0].km > 0.3) pushVirtual(0);
    for (const pl of placed) {
      while (last != null && pl.km - last > GAP_KM) pushVirtual(last + GAP_KM);
      if (last != null && pl.km - last < 0.05) continue;
      seq.push(pl);
      last = pl.km;
    }
    while (total - last > GAP_KM) pushVirtual(last + GAP_KM);
    if (total - last > 0.3) pushVirtual(total);
    if (seq.length < 2) continue;

    const kmh = total < 15 ? 16 : total < 40 ? 24 : 38;
    const shape = simplify(line, 0.00008).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]);
    const mk = (s, dir) => {
      const d0 = s[0].km;
      const dist = s.map((x) => +Math.abs(x.km - d0).toFixed(2));
      return {
        id: `a${n}${dir}`, route: route.id, headsign: dir ? (title(pick(p, 'CANTONINICIO')) || route.long) : (title(pick(p, 'CANTONFINAL')) || route.long),
        direction: dir, stops: s.map((x) => x.idx), dist, offsets: dist.map((d) => Math.round((d / kmh) * 60)),
        shape: dir ? [...shape].reverse() : shape, freq: { headway: 30, first: 5 * 60, last: 21 * 60, estimated: true },
      };
    };
    patterns.push(mk(seq, 0), mk([...seq].reverse(), 1));
    n += 1;
  }
  return {
    source: { publisher: 'ARESEP', url: 'https://aresep.go.cr/datos-abiertos/rutas-autobuses/', version: new Date().toISOString().slice(0, 10), license: 'Datos abiertos ARESEP' },
    agencies: [...new Set([...routes.values()].map((r) => r.agency).filter(Boolean))].map((name) => ({ id: name, name })),
    routes: [...routes.values()], stops, patterns, fares: {}, services: {},
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [ramales, osm, out] = process.argv.slice(2);
  const net = convertAresep(readJson(ramales), readJson(osm));
  fs.writeFileSync(out, JSON.stringify(net));
  const realN = net.stops.filter((s) => !s.virtual).length;
  console.log(`${out}: ${net.routes.length} rutas, ${net.patterns.length / 2} ramales, ${realN} paradas reales (+${net.stops.length - realN} puntos sobre la ruta), ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
}
