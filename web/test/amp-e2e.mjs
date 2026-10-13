// Prueba del amplificador en Chromium: una canción bajita debe sonar mucho más
// fuerte en modo "Máximo" sin pasarse de 0 dB (sin saturar).
//
//   cd web && npm install && npm run e2e:amp

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8766;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/** WAV estéreo de 16 bits: tono de 220 Hz con la amplitud indicada. */
function makeWav(file, amplitude, seconds = 20, rate = 44_100) {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amplitude * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const file = path.join(webDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

/** Promedia el nivel de salida durante `ms` milisegundos. */
async function averageLevel(page, ms = 1500) {
  return page.evaluate(async (duration) => {
    const amp = window.dualsoundAmp;
    const rms = [];
    let peak = -Infinity;
    const end = performance.now() + duration;
    while (performance.now() < end) {
      const l = amp.level();
      if (Number.isFinite(l.rmsDb)) rms.push(l.rmsDb);
      peak = Math.max(peak, l.peakDb);
      await new Promise((r) => setTimeout(r, 50));
    }
    return { rmsDb: rms.reduce((a, b) => a + b, 0) / rms.length, peakDb: peak };
  }, ms);
}

let exitCode = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/amplificador.html`);

  const wav = path.join(os.tmpdir(), 'cancion-bajita.wav');
  makeWav(wav, 0.08);
  await page.setInputFiles('#amp-files', wav);
  await page.waitForFunction(() => !document.getElementById('amp-audio').paused, null, { timeout: 10000 });
  assert.equal(await page.textContent('#amp-track'), 'cancion-bajita');

  await page.click('[data-preset="normal"]');
  await page.waitForTimeout(500);
  const normal = await averageLevel(page);
  await page.click('[data-preset="maximo"]');
  await page.waitForTimeout(800);
  const maximo = await averageLevel(page);
  console.log(`Normal: ${normal.rmsDb.toFixed(1)} dB RMS (pico ${normal.peakDb.toFixed(1)})`);
  console.log(`Máximo: ${maximo.rmsDb.toFixed(1)} dB RMS (pico ${maximo.peakDb.toFixed(1)})`);

  assert.ok(maximo.rmsDb - normal.rmsDb > 10, 'el modo Máximo debe sonar al menos 10 dB más fuerte');
  assert.ok(maximo.peakDb <= 0.1, 'el limitador no debe dejar pasar de 0 dB');

  // Canción que ya está fuerte (pico -1 dB): en Máximo no debe saturar.
  const loud = path.join(os.tmpdir(), 'cancion-fuerte.wav');
  makeWav(loud, 0.89);
  await page.setInputFiles('#amp-files', loud);
  await page.click('#amp-list li:nth-child(2) button');
  await page.waitForFunction(() => document.getElementById('amp-track').textContent === 'cancion-fuerte');
  await page.waitForTimeout(800);
  const fuerte = await averageLevel(page);
  console.log(`Canción fuerte en Máximo: ${fuerte.rmsDb.toFixed(1)} dB RMS (pico ${fuerte.peakDb.toFixed(1)})`);
  assert.ok(fuerte.peakDb <= 0.1, 'el limitador debe impedir la saturación');

  // El ajuste se recuerda.
  await page.reload();
  assert.equal(await page.getAttribute('[data-preset="maximo"]', 'aria-pressed'), 'true');

  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: path.join(os.tmpdir(), 'dualsound-amplificador.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('✅ Amplificador: prueba superada');
} catch (e) {
  exitCode = 1;
  console.error('❌', e);
} finally {
  await browser.close();
  server.close();
  process.exit(exitCode);
}
