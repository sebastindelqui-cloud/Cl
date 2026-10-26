// Convierte un GTFS (carpeta con los .txt) al formato compacto que usa la app.
//
//   node tools/gtfs-to-network.mjs data/gtfs-tsg data/cr-network.json
//
// Agrupa los viajes en "recorridos" (misma ruta, mismas paradas y mismos
// tiempos entre paradas) y guarda solo la hora de salida de cada viaje.

import fs from 'node:fs';
import path from 'node:path';

/** Lector de CSV con comillas (RFC 4180). Devuelve una lista de objetos. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const toMin = (t) => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 60 + m + (s || 0) / 60;
};

function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Simplifica una línea (Douglas-Peucker) con tolerancia en grados. */
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
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i += 1) {
      const t = Math.max(0, Math.min(1, ((points[i][0] - ax) * dx + (points[i][1] - ay) * dy) / len));
      const d = Math.hypot(points[i][0] - (ax + t * dx), points[i][1] - (ay + t * dy));
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Distancia a lo largo del trazado hasta el punto del trazado más cercano a cada parada (km). */
function distancesAlongShape(shape, stopsLatLng) {
  const cum = [0];
  for (let i = 1; i < shape.length; i += 1) cum.push(cum[i - 1] + haversineKm(shape[i - 1], shape[i]));
  let from = 0;
  return stopsLatLng.map((p) => {
    let best = from;
    let bestD = Infinity;
    // Avanza en orden para no "saltar atrás" en recorridos que pasan dos veces cerca.
    for (let i = from; i < shape.length; i += 1) {
      const d = (shape[i][0] - p[0]) ** 2 + (shape[i][1] - p[1]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    from = best;
    return +cum[best].toFixed(2);
  });
}

export function convert(dir) {
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')) : []);
  const agencies = read('agency.txt');
  const routes = read('routes.txt');
  const stopsRaw = read('stops.txt').filter((s) => (s.location_type || '0') === '0');
  const trips = read('trips.txt');
  const stopTimes = read('stop_times.txt');
  const shapesRaw = read('shapes.txt');
  const calendar = read('calendar.txt');
  const fareAttr = read('fare_attributes.txt');
  const fareRules = read('fare_rules.txt');
  const feed = read('feed_info.txt')[0] || {};

  // Une las paradas con el mismo nombre a menos de 40 m (p. ej. la terminal de
  // llegada y la de salida), para mostrarlas como una sola en el mapa.
  const stopIndex = new Map();
  const stops = [];
  for (const s of stopsRaw) {
    const lat = +(+s.stop_lat).toFixed(6);
    const lng = +(+s.stop_lon).toFixed(6);
    const same = stops.findIndex((o) => o.name === s.stop_name && haversineKm([o.lat, o.lng], [lat, lng]) < 0.04);
    if (same >= 0) { stopIndex.set(s.stop_id, same); continue; }
    stopIndex.set(s.stop_id, stops.length);
    stops.push({ id: s.stop_id, name: s.stop_name, lat, lng, zone: s.zone_id || null });
  }

  const shapes = new Map();
  for (const p of shapesRaw) {
    if (!shapes.has(p.shape_id)) shapes.set(p.shape_id, []);
    shapes.get(p.shape_id).push([+p.shape_pt_sequence, +p.shape_pt_lat, +p.shape_pt_lon]);
  }
  for (const [id, pts] of shapes) shapes.set(id, pts.sort((a, b) => a[0] - b[0]).map(([, la, lo]) => [la, lo]));

  const timesByTrip = new Map();
  for (const st of stopTimes) {
    if (!timesByTrip.has(st.trip_id)) timesByTrip.set(st.trip_id, []);
    timesByTrip.get(st.trip_id).push(st);
  }

  const patterns = new Map();
  for (const t of trips) {
    const st = (timesByTrip.get(t.trip_id) || []).sort((a, b) => +a.stop_sequence - +b.stop_sequence);
    if (st.length < 2) continue;
    const start = toMin(st[0].departure_time || st[0].arrival_time);
    const ids = st.map((x) => stopIndex.get(x.stop_id));
    if (ids.some((x) => x == null)) continue;
    const offsets = st.map((x) => Math.round(toMin(x.arrival_time || x.departure_time) - start));
    const key = `${t.route_id}|${t.direction_id}|${ids.join('.')}|${offsets.join('.')}`;
    if (!patterns.has(key)) {
      patterns.set(key, {
        route: t.route_id, headsign: t.trip_headsign, direction: +t.direction_id || 0, shapeId: t.shape_id, stops: ids, offsets, trips: {},
      });
    }
    const p = patterns.get(key);
    (p.trips[t.service_id] ||= []).push(Math.round(start));
  }

  const outPatterns = [...patterns.values()].map((p, i) => {
    const shape = shapes.get(p.shapeId) || p.stops.map((s) => [stops[s].lat, stops[s].lng]);
    const dist = distancesAlongShape(shape, p.stops.map((s) => [stops[s].lat, stops[s].lng]));
    for (const k of Object.keys(p.trips)) p.trips[k].sort((a, b) => a - b);
    return {
      id: `p${i}`, route: p.route, headsign: p.headsign, direction: p.direction,
      stops: p.stops, offsets: p.offsets, dist,
      shape: simplify(shape, 0.00004).map(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)]),
      trips: p.trips,
    };
  });

  const fares = {};
  const priceOf = new Map(fareAttr.map((f) => [f.fare_id, { price: +f.price, currency: f.currency_type }]));
  for (const r of fareRules) {
    const f = priceOf.get(r.fare_id);
    if (!f || !r.route_id) continue;
    (fares[r.route_id] ||= {})[`${r.origin_id}|${r.destination_id}`] = f.price;
  }

  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const services = Object.fromEntries(calendar.map((c) => [c.service_id, DAYS.map((d, i) => (c[d] === '1' ? i : -1)).filter((i) => i >= 0)]));

  return {
    source: {
      publisher: feed.feed_publisher_name || '', url: feed.feed_publisher_url || '', version: feed.feed_version || '',
      start: feed.feed_start_date || '', end: feed.feed_end_date || '',
    },
    agencies: agencies.map((a) => ({ id: a.agency_id, name: a.agency_name, url: a.agency_url, phone: a.agency_phone, fareUrl: a.agency_fare_url })),
    routes: routes.map((r) => ({
      id: r.route_id, agency: r.agency_id, short: r.route_short_name, long: r.route_long_name, desc: r.route_desc,
      color: `#${r.route_color || '1d4ed8'}`, text: `#${r.route_text_color || 'ffffff'}`, url: r.route_url,
    })),
    stops, patterns: outPatterns, fares, services,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [dir, out] = process.argv.slice(2);
  const net = convert(dir);
  fs.writeFileSync(out, JSON.stringify(net));
  const nTrips = net.patterns.reduce((n, p) => n + Object.values(p.trips).flat().length, 0);
  console.log(`${out}: ${net.routes.length} rutas, ${net.stops.length} paradas, ${net.patterns.length} recorridos, ${nTrips} viajes, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}
