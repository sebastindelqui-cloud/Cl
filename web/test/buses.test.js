import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceM, planTrip, boardingFare, discountFactor, formatMoney, formatClock, parseClock,
  isRunning, patternsOf, validateNetwork, monthlyCost, badgesFor, tripText,
} from '../buses.js';
import { EXAMPLE_NETWORK as NET } from '../buses-data.js';

const stop = (id) => NET.stops.find((s) => s.id === id);
const busLines = (o) => o.legs.filter((l) => l.type === 'bus').map((l) => l.line.id);

test('distanceM: 0,01° de latitud ≈ 1,11 km', () => {
  const d = distanceM({ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 });
  assert.ok(Math.abs(d - 1112) < 5, String(d));
});

test('la red de ejemplo es válida', () => {
  assert.deepEqual(validateNetwork(NET), []);
  assert.ok(validateNetwork({ stops: [], lines: [{ id: 'x', name: 'X', fare: 1, stops: ['a', 'b'] }] }).length > 0);
  assert.ok(validateNetwork(null).length > 0);
});

test('viaje directo en una sola línea', () => {
  const opts = planTrip(NET, stop('terminal-norte'), stop('terminal-sur'));
  assert.ok(opts.length > 0);
  const best = opts[0];
  assert.deepEqual(busLines(best), ['l1']);
  assert.equal(best.fare, 800);
  assert.equal(best.transfers, 0);
  const ride = best.legs.find((l) => l.type === 'bus');
  assert.equal(ride.towards, 'Terminal Sur');
  assert.equal(ride.stops, 5);
});

test('sentido contrario usa la dirección de vuelta', () => {
  const ride = planTrip(NET, stop('estadio'), stop('hospital'))[0].legs.find((l) => l.type === 'bus');
  assert.equal(ride.towards, 'Terminal Norte');
});

test('con transbordo cobra la tarifa de transbordo', () => {
  const opts = planTrip(NET, stop('aeropuerto'), stop('terminal-norte'));
  const t = opts.find((o) => o.transfers === 1 && busLines(o).join() === 'l2,l1');
  assert.ok(t, JSON.stringify(opts.map(busLines)));
  assert.equal(t.fare, 800 + 200);
});

test('aparece la opción barata aunque haya una más rápida', () => {
  // Norte → Universidad: el expreso (1.200) es directo; Línea 1 + Circular cuesta 800 + 200.
  const opts = planTrip(NET, stop('terminal-norte'), stop('universidad'));
  const fares = opts.filter((o) => o.buses > 0).map((o) => o.fare);
  assert.ok(fares.includes(1200), String(fares));
  assert.ok(Math.min(...fares) < 1200, String(fares));
  const badges = badgesFor(opts);
  assert.ok([...badges.values()].flat().includes('Más barata'));
});

test('cerca: caminar es una opción', () => {
  const opts = planTrip(NET, stop('plaza'), stop('catedral'));
  assert.ok(opts.some((o) => o.buses === 0));
});

test('sin paradas cerca no hay viaje en bus', () => {
  const far = { lat: NET.center[0] + 1, lng: NET.center[1] + 1 };
  assert.equal(planTrip(NET, far, stop('plaza')).length, 0);
});

test('línea circular vuelve al inicio', () => {
  const p = patternsOf(NET.lines.find((l) => l.circular));
  assert.equal(p.length, 1);
  assert.equal(p[0].ids[0], p[0].ids.at(-1));
});

test('tarifas de transbordo', () => {
  const line = { fare: 1000 };
  assert.equal(boardingFare({ transfer: { policy: 'full' } }, line, 1, 10), 1000);
  assert.equal(boardingFare({ transfer: { policy: 'free', windowMin: 90 } }, line, 1, 10), 0);
  assert.equal(boardingFare({ transfer: { policy: 'free', windowMin: 90 } }, line, 1, 120), 1000);
  assert.equal(boardingFare({ transfer: { policy: 'fixed', amount: 300 } }, line, 2, 10), 300);
  assert.equal(boardingFare({ transfer: { policy: 'free' } }, line, 0, 0), 1000);
});

test('descuentos', () => {
  assert.equal(discountFactor(NET, 'general'), 1);
  assert.equal(discountFactor(NET, 'estudiante'), 0.4);
});

test('formatos', () => {
  assert.equal(formatMoney(2950, '$'), '$ 2.950');
  assert.equal(formatMoney(1234567, 'COP'), 'COP 1.234.567');
  assert.equal(formatMoney(1.5, 'S/'), 'S/ 1,50');
  assert.equal(formatClock(23 * 60 + 75), '00:15');
  assert.equal(parseClock('7:05'), 425);
  assert.equal(parseClock('mañana'), null);
});

test('horario de funcionamiento', () => {
  assert.ok(isRunning({ firstBus: '05:00', lastBus: '22:00' }, 12 * 60));
  assert.ok(!isRunning({ firstBus: '05:00', lastBus: '22:00' }, 23 * 60));
  assert.ok(isRunning({ firstBus: '20:00', lastBus: '02:00' }, 60));
  assert.ok(isRunning({}, 3 * 60));
});

test('avisa si la línea no funciona a esa hora', () => {
  const opts = planTrip(NET, stop('terminal-norte'), stop('terminal-sur'), { departAt: 3 * 60 });
  assert.ok(opts[0].legs.some((l) => l.notRunning));
});

test('gasto mensual y texto para compartir', () => {
  assert.ok(Math.abs(monthlyCost(800, 2, 5) - 34_666.67) < 0.1);
  const o = planTrip(NET, stop('terminal-norte'), stop('terminal-sur'))[0];
  const text = tripText(o, NET, { from: stop('terminal-norte'), to: stop('terminal-sur'), passengers: 2 });
  assert.match(text, /Línea 1/);
  assert.match(text, /\$ 1\.600/);
});
