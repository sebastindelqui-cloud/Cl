import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbToGain, measureLevel, meterPercent, PRESETS, MAX_BOOST_DB, MAX_BASS_DB } from '../amp.js';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('dbToGain', () => {
  assert.equal(dbToGain(0), 1);
  near(dbToGain(6), 1.995, 0.001);
  near(dbToGain(20), 10, 1e-9);
  near(dbToGain(-20), 0.1, 1e-9);
});

test('measureLevel: seno de amplitud 0,5', () => {
  const s = Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const { rmsDb, peakDb } = measureLevel(s);
  near(peakDb, -6.02, 0.05);
  near(rmsDb, -9.03, 0.05);
  assert.equal(measureLevel(new Float32Array(10)).rmsDb, -Infinity);
});

test('meterPercent', () => {
  assert.equal(meterPercent(0), 100);
  assert.equal(meterPercent(-30), 50);
  assert.equal(meterPercent(-90), 0);
  assert.equal(meterPercent(-Infinity), 0);
});

test('los modos están dentro de los límites', () => {
  for (const p of Object.values(PRESETS)) {
    assert.ok(p.boostDb >= 0 && p.boostDb <= MAX_BOOST_DB);
    assert.ok(p.bassDb >= 0 && p.bassDb <= MAX_BASS_DB);
  }
});
