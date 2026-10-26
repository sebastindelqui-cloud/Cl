import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  distanceM, planTrip, planOptions, nextDepartures, fareFor, seniorFactor, servicesFor,
  formatClock, formatColones, formatDistance, routeTimetable, routesAtStop, tripText,
} from '../buses-core.js';
import { parseCsv, convert } from '../tools/gtfs-to-network.mjs';

const NET = JSON.parse(fs.readFileSync(new URL('../data/cr-network.json', import.meta.url)));
const idx = (name) => NET.stops.findIndex((s) => s.name.startsWith(name));
const stop = (name) => NET.stops[idx(name)];
const SJ = 'Terminal en San José';
const MONDAY = 1;

test('parseCsv entiende comillas', () => {
  const rows = parseCsv('a,b\n"x, y",2\n"con ""comillas""",3\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: '2' }, { a: 'con "comillas"', b: '3' }]);
});

test('el archivo de la red coincide con el GTFS', () => {
  const fresh = convert(new URL('../data/gtfs-tsg', import.meta.url).pathname);
  assert.equal(JSON.stringify(fresh), JSON.stringify(NET), 'vuelve a correr tools/gtfs-to-network.mjs');
});

test('la red tiene las rutas reales de Transportes San Gabriel', () => {
  assert.deepEqual(NET.routes.map((r) => r.id).sort(), ['ACOS', 'SGAB', 'TURR']);
  assert.ok(NET.stops.length > 150);
  for (const s of NET.stops) {
    assert.ok(s.lat > 9.6 && s.lat < 10.1 && s.lng > -84.3 && s.lng < -83.9, `${s.name} fuera de la zona`);
  }
});

test('servicios por día', () => {
  assert.deepEqual(servicesFor(NET, MONDAY), ['entresemana']);
  assert.deepEqual(servicesFor(NET, 6), ['sabado']);
  assert.deepEqual(servicesFor(NET, 0), ['domingo']);
});

test('viaje directo de Los Mangos a San José un lunes a las 6 a. m.', () => {
  const opts = planTrip(NET, stop('Terminal Los Mangos'), stop(SJ), { departAt: 6 * 60, weekday: MONDAY });
  assert.ok(opts.length >= 1);
  const o = opts[0];
  assert.equal(o.buses, 1);
  assert.ok(['SGAB', 'TURR', 'ACOS'].includes(o.firstBus.route.id));
  assert.ok(o.firstBus.depart >= 6 * 60, 'no sale antes de la hora pedida');
  assert.ok(o.arrive > o.firstBus.depart);
  assert.ok([990, 905, 1085].includes(o.fare), `tarifa completa hasta San José: ${o.fare}`);
});

test('viaje corto paga tarifa mínima', () => {
  const p = NET.patterns.find((x) => x.route === 'SGAB' && x.direction === 0);
  const a = NET.stops[p.stops[1]];
  const b = NET.stops[p.stops[5]];
  const o = planTrip(NET, a, b, { departAt: 7 * 60, weekday: MONDAY }).find((x) => x.buses === 1);
  assert.ok(o);
  assert.equal(o.fare, 510);
});

test('sin paradas cerca no hay viaje en bus', () => {
  assert.equal(planTrip(NET, { lat: 10.6, lng: -85.4 }, stop(SJ), { departAt: 480, weekday: MONDAY }).length, 0);
});

test('después del último bus no hay viaje ese día', () => {
  const opts = planTrip(NET, stop('Terminal Los Mangos'), stop(SJ), { departAt: 23 * 60 + 59, weekday: MONDAY });
  assert.equal(opts.length, 0);
});

test('varias opciones con buses siguientes, en orden', () => {
  const opts = planOptions(NET, stop('Terminal Los Mangos'), stop(SJ), { departAt: 6 * 60, weekday: MONDAY, count: 3 });
  assert.equal(opts.length, 3);
  const departs = opts.map((o) => o.firstBus.depart);
  assert.deepEqual([...departs].sort((a, b) => a - b), departs);
  assert.equal(new Set(departs).size, 3);
});

test('próximas salidas en la terminal de San José', () => {
  const list = nextDepartures(NET, idx(SJ), { now: 12 * 60, weekday: MONDAY, limit: 5 });
  assert.equal(list.length, 5);
  assert.ok(list.every((d) => d.time >= 12 * 60));
  assert.ok(list.every((d, i) => i === 0 || d.time >= list[i - 1].time));
  assert.ok(routesAtStop(NET, idx(SJ)).length === 3);
});

test('tarifas por zona y beneficio de adulto mayor', () => {
  assert.equal(fareFor(NET, 'SGAB', { zone: 'SGAB_A' }, { zone: 'RUTA_G' }), 990);
  assert.equal(fareFor(NET, 'SGAB', { zone: 'RUTA_G' }, { zone: 'SGAB_A' }), 990);
  assert.equal(seniorFactor(10), 0);
  assert.equal(seniorFactor(27), 0.5);
  assert.equal(seniorFactor(60), 0.75);
});

test('horario de una ruta', () => {
  const t = routeTimetable(NET, 'SGAB', MONDAY);
  const all = Object.values(t).flat();
  assert.ok(all.length >= 30);
});

test('formatos de Costa Rica', () => {
  assert.equal(formatClock(14 * 60 + 5), '2:05 p. m.');
  assert.equal(formatClock(0), '12:00 a. m.');
  assert.equal(formatClock(9 * 60 + 30), '9:30 a. m.');
  assert.equal(formatColones(1085), '₡1.085');
  assert.equal(formatColones(510), '₡510');
  assert.equal(formatDistance(100), '130 m');
  assert.ok(distanceM({ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 }) > 1100);
});

test('texto para compartir', () => {
  const o = planTrip(NET, stop('Terminal Los Mangos'), stop(SJ), { departAt: 6 * 60, weekday: MONDAY })[0];
  const text = tripText(o, { from: { name: 'Casa' }, to: { name: 'Trabajo' } });
  assert.match(text, / - San José en /);
  assert.match(text, /₡\d/);
});

// ---------- OpenStreetMap ----------

import { convertOsm, chainWays, parseInterval, parseCharge, parseHours } from '../tools/osm-to-network.mjs';
import { mergeNetworks, departuresOf } from '../buses-core.js';

const OSM_ROUTES = {
  elements: [{
    type: 'relation', id: 101,
    tags: { type: 'route', route: 'bus', ref: '300', name: 'Bus 300: Heredia → San José', from: 'Heredia', to: 'San José', operator: 'Empresa X', charge: '₡ 650', interval: '00:15' },
    members: [
      { type: 'node', ref: 1, role: 'platform', lat: 9.998, lon: -84.117 },
      { type: 'node', ref: 2, role: 'platform', lat: 9.97, lon: -84.1 },
      { type: 'node', ref: 3, role: 'platform', lat: 9.935, lon: -84.08 },
      { type: 'way', ref: 11, role: '', geometry: [{ lat: 9.97, lon: -84.1 }, { lat: 9.998, lon: -84.117 }] },
      { type: 'way', ref: 12, role: '', geometry: [{ lat: 9.97, lon: -84.1 }, { lat: 9.935, lon: -84.08 }] },
    ],
  }, {
    type: 'relation', id: 102,
    tags: { type: 'route', route: 'bus', ref: '400', name: 'Ruta sin paradas' },
    members: [{ type: 'way', ref: 21, role: '', geometry: [{ lat: 10.0, lon: -84.2 }, { lat: 10.03, lon: -84.2 }] }],
  }],
};
const OSM_STOPS = { elements: [{ type: 'node', id: 1, lat: 9.998, lon: -84.117, tags: { highway: 'bus_stop', name: 'Parque de Heredia', shelter: 'yes' } }] };

test('convertir rutas de OpenStreetMap', () => {
  const net = convertOsm(OSM_ROUTES, OSM_STOPS);
  assert.equal(net.routes.length, 2);
  const r = net.routes.find((x) => x.short === '300');
  assert.equal(r.fare, 650);
  const p = net.patterns.find((x) => x.route === r.id);
  assert.equal(p.stops.length, 3);
  assert.equal(net.stops[p.stops[0]].name, 'Parque de Heredia');
  assert.equal(p.freq.headway, 15);
  assert.equal(p.freq.estimated, false);
  assert.ok(p.dist.at(-1) > 6 && p.dist.at(-1) < 10, String(p.dist.at(-1)));
  assert.ok(p.offsets.every((o, i) => i === 0 || o >= p.offsets[i - 1]));
  const sinParadas = net.patterns.find((x) => x.route !== r.id);
  assert.ok(sinParadas.stops.length >= 3, 'genera puntos sobre la ruta');
  assert.ok(net.stops[sinParadas.stops[0]].virtual);
  assert.equal(sinParadas.freq.estimated, true);
});

test('unir el tramo invertido de una ruta', () => {
  const line = chainWays([[[0, 0], [0, 1]], [[0, 2], [0, 1]]]);
  assert.deepEqual(line, [[0, 0], [0, 1], [0, 2]]);
});

test('etiquetas de OpenStreetMap', () => {
  assert.equal(parseInterval('00:20'), 20);
  assert.equal(parseInterval('15-25'), 20);
  assert.equal(parseInterval('PT1H'), 60);
  assert.equal(parseCharge('CRC 1.085'), 1085);
  assert.equal(parseCharge('₡650'), 650);
  assert.equal(parseCharge('gratis'), null);
  assert.deepEqual(parseHours('Mo-Su 04:30-23:00'), { first: 270, last: 1380 });
});

test('planificar con rutas oficiales y de OpenStreetMap juntas', () => {
  const all = mergeNetworks(NET, convertOsm(OSM_ROUTES, OSM_STOPS));
  assert.equal(all.routes.length, NET.routes.length + 2);
  const heredia = all.stops.find((s) => s.name === 'Parque de Heredia');
  const p = all.patterns.find((x) => x.freq && !x.freq.estimated);
  assert.equal(departuresOf(p, []).length, Math.floor((21 * 60 - 5 * 60) / 15) + 1);
  const end = all.stops[p.stops.at(-1)];
  const o = planTrip(all, heredia, end, { departAt: 8 * 60, weekday: MONDAY })[0];
  assert.ok(o, 'encuentra el viaje en la ruta 300');
  assert.equal(o.fare, 650);
  assert.ok(o.estimated);
  // Las rutas oficiales siguen igual después de unir.
  const sg = planTrip(all, stop('Terminal Los Mangos'), stop(SJ), { departAt: 6 * 60, weekday: MONDAY })[0];
  assert.ok(sg && !sg.estimated);
});
