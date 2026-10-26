// Convierte las rutas de bus de OpenStreetMap (descargadas con Overpass por el
// workflow "Descargar datos de buses de Costa Rica") al formato de la app.
//
//   node tools/osm-to-network.mjs osm-routes.json osm-stops.json data/cr-osm.json
//
// OpenStreetMap tiene recorridos y paradas, pero casi nunca horarios: cada
// recorrido se guarda con una frecuencia ("pasa cada N min", de la etiqueta
// interval si existe) y la app muestra esas horas como aproximadas.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PALETTE = ['#1a56c4', '#d93025', '#188038', '#e37400', '#8430ce', '#00897b', '#c2185b', '#5d4037', '#3949ab', '#7cb342'];

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

/** Une los tramos (ways) de una relación en una sola línea, girándolos cuando hace falta. */
export function chainWays(ways) {
  const list = ways.filter((w) => w.length >= 2);
  if (!list.length) return [];
  const close = (a, b) => haversineKm(a, b) < 0.03;
  let line = [...list[0]];
  if (list[1] && !close(line.at(-1), list[1][0]) && !close(line.at(-1), list[1].at(-1))
    && (close(line[0], list[1][0]) || close(line[0], list[1].at(-1)))) line.reverse();
  for (let i = 1; i < list.length; i += 1) {
    const w = list[i];
    const end = line.at(-1);
    const dStart = haversineKm(end, w[0]);
    const dEnd = haversineKm(end, w.at(-1));
    line.push(...(dEnd < dStart ? [...w].reverse() : w).slice(1));
  }
  return line;
}

/** Distancia (km) a lo largo de la línea del punto más cercano a cada parada, sin retroceder. */
export function distancesAlong(line, pts) {
  const cum = [0];
  for (let i = 1; i < line.length; i += 1) cum.push(cum[i - 1] + haversineKm(line[i - 1], line[i]));
  let from = 0;
  return pts.map((p) => {
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < line.length; i += 1) {
      const d = (line[i][0] - p[0]) ** 2 + (line[i][1] - p[1]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    from = best;
    return +cum[best].toFixed(2);
  });
}

/** "00:20", "20", "15-20", "PT20M" → minutos. */
export function parseInterval(v) {
  if (!v) return null;
  const s = String(v).split(';')[0].trim();
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]) || null;
  m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(s);
  if (m) return (Number(m[1] || 0) * 60 + Number(m[2] || 0)) || null;
  m = /^(\d+)(?:\s*-\s*(\d+))?/.exec(s);
  if (m) return Math.round((Number(m[1]) + Number(m[2] || m[1])) / 2) || null;
  return null;
}

/** "Mo-Su 05:00-22:00" → { first, last } en minutos (solo el primer rango). */
export function parseHours(v) {
  const m = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  return { first: Number(m[1]) * 60 + Number(m[2]), last: Number(m[3]) * 60 + Number(m[4]) };
}

/** "₡650", "CRC 650", "650 colones" → 650. */
export function parseCharge(v) {
  if (!v) return null;
  const m = /(\d[\d.,]*)/.exec(String(v).replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return n > 0 && n < 20_000 ? Math.round(n) : null;
}

const readJson = (file) => {
  const buf = fs.readFileSync(file);
  return JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8'));
};

export function convertOsm(routesJson, stopsJson, { skipOperators = /san gabriel/i } = {}) {
  const stopInfo = new Map();
  for (const n of stopsJson.elements || []) if (n.type === 'node') stopInfo.set(n.id, n);

  const stops = [];
  const stopIdx = new Map();
  const addStop = (id, lat, lng, tags = {}, virtualName = null) => {
    const key = virtualName ? `v${stops.length}` : `n${id}`;
    if (stopIdx.has(key)) return stopIdx.get(key);
    const name = virtualName || tags.name || tags['name:es'] || tags.description || tags.ref || 'Parada';
    stopIdx.set(key, stops.length);
    stops.push({ id: key, name, lat: +lat.toFixed(6), lng: +lng.toFixed(6), zone: null, ...(virtualName ? { virtual: true } : {}), ...(tags.shelter === 'yes' ? { shelter: true } : {}) });
    return stops.length - 1;
  };

  const routes = new Map();
  const patterns = [];
  let skipped = 0;
  for (const rel of routesJson.elements || []) {
    if (rel.type !== 'relation') continue;
    const t = rel.tags || {};
    if (skipOperators && skipOperators.test(t.operator || '')) { skipped += 1; continue; }
    const members = rel.members || [];
    const ways = members.filter((m) => m.type === 'way' && !/platform/.test(m.role || '') && m.geometry)
      .map((m) => m.geometry.filter(Boolean).map((g) => [g.lat, g.lon]));
    let line = chainWays(ways);

    const nodes = members.filter((m) => m.type === 'node' && m.lat != null);
    const platforms = nodes.filter((m) => /^platform/.test(m.role || ''));
    const stopPos = nodes.filter((m) => /^stop/.test(m.role || ''));
    const chosen = platforms.length >= 2 ? platforms : stopPos.length >= 2 ? stopPos : [...stopPos, ...platforms];
    let seq = [];
    for (const m of chosen) {
      const info = stopInfo.get(m.ref);
      const idx = addStop(m.ref, m.lat, m.lon, info?.tags || {});
      const prev = seq.at(-1);
      if (prev != null && haversineKm([stops[prev].lat, stops[prev].lng], [stops[idx].lat, stops[idx].lng]) < 0.025) continue;
      seq.push(idx);
    }
    if (line.length < 2) line = seq.map((i) => [stops[i].lat, stops[i].lng]);
    if (line.length < 2) { skipped += 1; continue; }

    const ref = (t.ref || '').trim();
    const name = (t.name || '').trim();
    const routeKey = `${ref || name || rel.id}|${t.operator || ''}`;

    // Sin paradas en OpenStreetMap: puntos cada ~600 m para poder subirse en el camino.
    if (seq.length < 2) {
      const total = distancesAlong(line, [line.at(-1)])[0];
      const n = Math.max(2, Math.round(total / 0.6) + 1);
      const cum = [0];
      for (let i = 1; i < line.length; i += 1) cum.push(cum[i - 1] + haversineKm(line[i - 1], line[i]));
      seq = [];
      for (let k = 0; k < n; k += 1) {
        const target = (total * k) / (n - 1);
        let i = cum.findIndex((c) => c >= target);
        if (i < 0) i = line.length - 1;
        seq.push(addStop(null, line[i][0], line[i][1], {}, `Sobre la ruta ${ref || name}`));
      }
    }

    if (!routes.has(routeKey)) {
      const id = `osm${rel.id}`;
      const from = t.from || stops[seq[0]].name;
      const to = t.to || stops[seq.at(-1)].name;
      routes.set(routeKey, {
        id, agency: t.operator || t.network || '', short: ref || (name.split(/[:\-–]/)[0].trim().slice(0, 14)) || 'Bus',
        long: name || `${from} – ${to}`, desc: [t.operator, t.network].filter(Boolean).join(' · '),
        color: /^#[0-9a-f]{6}$/i.test(t.colour || '') ? t.colour : PALETTE[routes.size % PALETTE.length], text: '#ffffff',
        url: t.website || '', fare: parseCharge(t.charge), osm: rel.id, source: 'osm',
      });
    }
    const route = routes.get(routeKey);
    if (!route.fare) route.fare = parseCharge(t.charge);

    const dist = distancesAlong(line, seq.map((i) => [stops[i].lat, stops[i].lng]));
    const totalKm = Math.max(dist.at(-1), 0.5);
    const durTag = parseInterval(t.duration);
    const kmh = totalKm < 15 ? 16 : totalKm < 40 ? 24 : 38;
    const totalMin = durTag || (totalKm / kmh) * 60;
    const offsets = dist.map((d) => Math.round((d / totalKm) * totalMin));
    const hours = parseHours(t.opening_hours) || { first: 5 * 60, last: 21 * 60 };
    const interval = parseInterval(t.interval);
    patterns.push({
      id: `o${rel.id}`, route: route.id, headsign: t.to || stops[seq.at(-1)].name, direction: 0,
      stops: seq, offsets, dist,
      shape: simplify(line, 0.00008).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]),
      freq: { headway: interval || 30, first: hours.first, last: hours.last, estimated: !interval },
    });
  }

  return {
    source: {
      publisher: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', version: new Date().toISOString().slice(0, 10),
      license: 'ODbL 1.0',
    },
    agencies: [...new Set([...routes.values()].map((r) => r.agency).filter(Boolean))].map((name) => ({ id: name, name })),
    routes: [...routes.values()],
    stops,
    patterns,
    fares: {},
    services: {},
    skipped,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [routesFile, stopsFile, out] = process.argv.slice(2);
  const net = convertOsm(readJson(routesFile), readJson(stopsFile));
  fs.writeFileSync(out, JSON.stringify(net));
  const real = net.stops.filter((s) => !s.virtual).length;
  console.log(`${out}: ${net.routes.length} rutas, ${net.patterns.length} recorridos, ${real} paradas (+${net.stops.length - real} puntos de ruta), ${net.skipped} omitidas, ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
}
