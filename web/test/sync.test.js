import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClockSync, anchorPosition, planStart, wrapPosition, PlaybackModel, DriftController,
  syncQuality, splitBuffer, FileAssembler, renderClickTrack, makePairingCode, peerIdForCode,
  formatMs, formatTime,
} from '../sync.js';

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} no está a ±${tolerance} de ${expected}`);

/** Simula un ping con un reloj remoto `trueOffset` ms adelantado y demoras de red dadas. */
function sample(local, trueOffset, up, down, processing = 0.2) {
  const t0 = local;
  const t1 = t0 + trueOffset + up;
  const t2 = t1 + processing;
  const t3 = t2 - trueOffset + down;
  return { t0, t1, t2, t3 };
}

test('ClockSync: el filtro de mínimo RTT ignora mediciones con mucho jitter', () => {
  const sync = new ClockSync();
  assert.equal(sync.offset, null);
  const trueOffset = -98765.4;
  const delays = [[40, 2], [2, 30], [1.5, 1.6], [20, 90], [60, 4], [10, 11]];
  delays.forEach(([up, down], i) => sync.add(sample(i * 1000, trueOffset, up, down)));
  assert.ok(sync.isSynced);
  near(sync.offset, trueOffset, 0.1);
  near(sync.bestRoundTrip, 3.1, 0.01);
});

test('ClockSync: descarta mediciones inválidas y mantiene una ventana', () => {
  const sync = new ClockSync({ windowSize: 3, maxRoundTrip: 100, minSamples: 2 });
  assert.equal(sync.add(sample(0, 5, 200, 200)), false);
  assert.equal(sync.add({ t0: 10, t1: 0, t2: 0, t3: 9 }), false);
  for (let i = 0; i < 5; i += 1) sync.add(sample(i, 5, 3, 3));
  assert.equal(sync.samples.length, 3);
  near(sync.offset, 5, 1e-9);
  sync.reset();
  assert.equal(sync.isSynced, false);
});

test('planStart: arranque normal usa el ancla y el retardo manual', () => {
  const anchor = { startHost: 10_000, offset: 30 };
  assert.deepEqual(planStart(anchor, 9_000), { hostTime: 10_000, position: 30 });
  assert.deepEqual(planStart(anchor, 9_000, { delayMs: 50 }), { hostTime: 10_050, position: 30 });
});

test('planStart: un receptor que llega tarde se suma en la posición correcta', () => {
  const anchor = { startHost: 10_000, offset: 30 };
  const plan = planStart(anchor, 15_000, { delayMs: 20, marginMs: 400 });
  // Debe sonar dentro de 400 ms y, descontando su retardo, coincidir con el ancla.
  assert.equal(plan.hostTime, 15_400);
  near(plan.position, anchorPosition(anchor, plan.hostTime - 20), 1e-9);
  near(plan.position, 35.38, 1e-9);
});

test('Dos dispositivos con relojes distintos emiten la misma posición a la vez', () => {
  const anchor = { startHost: 50_000, offset: 0 };
  const receiverOffset = 123_456.7; // emisor − receptor
  const planHost = planStart(anchor, 49_000);
  const planReceiver = planStart(anchor, 49_000, { delayMs: 15 });
  const receiverLocalTime = planReceiver.hostTime - receiverOffset;
  // Traducido de vuelta al reloj del emisor y descontando su retardo manual:
  near(receiverLocalTime + receiverOffset - 15, planHost.hostTime, 1e-9);
  assert.equal(planReceiver.position, planHost.position);
});

test('wrapPosition repite pistas en bucle', () => {
  assert.equal(wrapPosition(65, 60, true), 5);
  assert.equal(wrapPosition(-1, 60, true), 59);
  assert.equal(wrapPosition(65, 60, false), 65);
});

test('PlaybackModel integra los cambios de velocidad', () => {
  const m = new PlaybackModel();
  m.start(10, 2);
  assert.equal(m.positionAt(12), 4);
  m.setRate(12, 1.002);
  near(m.positionAt(13), 5.002, 1e-12);
  assert.equal(m.hasStarted(9), false);
  assert.equal(m.hasStarted(10), true);
});

test('DriftController: zona muerta, límites y resincronización', () => {
  const d = new DriftController();
  assert.deepEqual(d.update(0.001), { action: 'rate', rate: 1 });
  const slow = new DriftController().update(0.004);
  assert.ok(slow.rate < 1 && slow.rate >= 0.998);
  near(new DriftController().update(-0.03).rate, 1.002, 1e-12);
  assert.deepEqual(new DriftController().update(0.1), { action: 'resync' });
});

test('DriftController: lazo cerrado compensa 80 ppm durante 10 minutos', () => {
  const d = new DriftController();
  let error = 0;
  let rate = 1;
  let worst = 0;
  for (let step = 0; step < 600; step += 1) {
    error += 1 * ((1 + 80e-6) * rate - 1);
    const r = d.update(error);
    assert.equal(r.action, 'rate');
    rate = r.rate;
    if (step > 10) worst = Math.max(worst, Math.abs(error));
  }
  assert.ok(worst < 0.004, `peor error ${worst}`);
});

test('syncQuality clasifica el peor error', () => {
  assert.equal(syncQuality([0.001], { playing: false }).level, 'idle');
  assert.equal(syncQuality([0.001], { clockReady: false }).level, 'syncing');
  assert.equal(syncQuality([0.001, -0.003]).level, 'good');
  assert.equal(syncQuality([0.001, -0.012]).level, 'fair');
  assert.equal(syncQuality([NaN, 0.05]).level, 'poor');
  assert.equal(syncQuality([null, NaN]).level, 'syncing');
});

test('splitBuffer + FileAssembler reconstruyen el archivo en cualquier orden', () => {
  const original = new Uint8Array(200_000).map((_, i) => (i * 7) % 256).buffer;
  const chunks = splitBuffer(original, 64 * 1024);
  assert.equal(chunks.length, 4);
  const asm = new FileAssembler('a', original.byteLength, chunks.length);
  [3, 1, 0, 2].forEach((i) => asm.add(i, new Uint8Array(chunks[i])));
  assert.equal(asm.add(1, chunks[1]), false, 'duplicado ignorado');
  assert.ok(asm.complete);
  assert.deepEqual(new Uint8Array(asm.assemble()), new Uint8Array(original));
});

test('FileAssembler detecta archivos incompletos o de tamaño incorrecto', () => {
  const asm = new FileAssembler('b', 10, 2);
  asm.add(0, new ArrayBuffer(5));
  assert.throws(() => asm.assemble(), /incompleto/);
  asm.add(1, new ArrayBuffer(4));
  assert.throws(() => asm.assemble(), /Tamaño/);
});

test('renderClickTrack: bips en cada pulso y silencio entre medio', () => {
  const rate = 48_000;
  const track = renderClickTrack(rate, 2);
  assert.equal(track.length, 96_000);
  assert.notEqual(track[240], 0); // 5 ms
  assert.equal(track[rate / 4], 0); // 250 ms
  assert.notEqual(track[rate / 2 + 240], 0);
  assert.ok(track.every((v) => v >= -1 && v <= 1));
});

test('códigos de emparejamiento e identificadores', () => {
  assert.equal(makePairingCode(() => 0), '100000');
  assert.equal(makePairingCode(() => 0.999999), '999999');
  assert.equal(peerIdForCode(' 123 456 '), 'dualsound-v1-123456');
});

test('formatos', () => {
  assert.equal(formatMs(0.0123), '12,3 ms');
  assert.equal(formatMs(0.005, { signed: true, digits: 0 }), '+5 ms');
  assert.equal(formatMs(NaN), '—');
  assert.equal(formatTime(125.9), '2:05');
});
