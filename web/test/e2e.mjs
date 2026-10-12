// Prueba de extremo a extremo: un emisor y un receptor en dos navegadores
// Chromium, con un servidor PeerJS local (sin internet).
//
//   cd web && npm install && npm run e2e
//
// Comprueba: emparejamiento por código, sincronización de reloj, envío de un
// archivo, reproducción simultánea con error < 5 ms, pausa, y reconexión
// automática cuando el receptor recarga la página.

import { chromium } from 'playwright';
import { PeerServer } from 'peer';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PORT = 8765;
const PEER_PORT = 9765;
const query = `?peerHost=127.0.0.1&peerPort=${PEER_PORT}&peerPath=/&peerSecure=0`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
}

/** WAV estéreo de 16 bits con un tono, para probar el envío de archivos. */
function makeWav(file, seconds = 8, rate = 44_100) {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

async function sampleErrors(page, getter, ms = 4000) {
  const errors = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const e = await page.evaluate(getter);
    if (Number.isFinite(e)) errors.push(e);
    await new Promise((r) => setTimeout(r, 250));
  }
  return errors;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.join(webDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));
const peerServer = PeerServer({ port: PEER_PORT, path: '/', host: '127.0.0.1' });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const pageErrors = [];
async function openPage(hash) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${hash}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${hash} console: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/${query}#${hash}`);
  return page;
}

let exitCode = 0;
try {
  // --- Receptor -------------------------------------------------------------
  const rx = await openPage('receptor');
  await rx.click('#rx-unlock');
  await rx.waitForFunction(() => window.dualsoundReceiver?.state === 'waiting', null, { timeout: 15000 });
  const code = await rx.evaluate(() => window.dualsoundReceiver.code);
  log('Receptor listo con código', code);

  // --- Emisor: conectar --------------------------------------------------------
  const tx = await openPage('emisor');
  await tx.waitForFunction(() => window.dualsoundHost?.peer?.open, null, { timeout: 15000 });
  await tx.fill('#connect-code', code);
  await tx.click('#connect-form button');
  await tx.waitForFunction((c) => window.dualsoundHost.receivers.get(c)?.state === 'connected', code, { timeout: 15000 });
  await rx.waitForFunction(() => window.dualsoundReceiver.clock.isSynced, null, { timeout: 10000 });
  log('Conectados; reloj sincronizado. RTT', await rx.evaluate(() => window.dualsoundReceiver.clock.bestRoundTrip.toFixed(2)), 'ms');

  // --- Pista de calibración ----------------------------------------------------
  await tx.click('#host-click');
  await tx.waitForFunction((c) => window.dualsoundHost.receivers.get(c)?.readyTrackId === window.dualsoundHost.track.id, code);
  await tx.click('#host-play');
  await rx.waitForFunction(() => window.dualsoundReceiver.player.playing, null, { timeout: 10000 });
  await tx.waitForFunction(() => window.dualsoundHost.player.playing, null, { timeout: 10000 });
  const rxErr = await sampleErrors(rx, () => window.dualsoundReceiver.player.lastError);
  const txErr = await sampleErrors(tx, () => window.dualsoundHost.player.lastError, 1000);
  const worst = Math.max(...rxErr.map(Math.abs), ...txErr.map(Math.abs));
  log(`Clics: ${rxErr.length} mediciones; peor error ${(worst * 1000).toFixed(2)} ms`);
  assert.ok(rxErr.length > 5, 'el receptor debe medir su error');
  assert.ok(worst < 0.005, `error de sincronía demasiado alto: ${worst}`);

  // Ambos reproducen la misma posición de la pista al mismo tiempo (comparando
  // en el reloj del emisor la posición que debería estar sonando).
  const expectedTx = await tx.evaluate(() => {
    const h = window.dualsoundHost;
    return { anchor: h.anchor };
  });
  const rxAnchor = await rx.evaluate(() => window.dualsoundReceiver.pendingPlay.anchor);
  assert.deepEqual(rxAnchor, expectedTx.anchor, 'el receptor usa el mismo ancla que el emisor');

  // --- Pausa -----------------------------------------------------------------
  await tx.click('#host-play');
  await rx.waitForFunction(() => !window.dualsoundReceiver.player.playing, null, { timeout: 5000 });
  log('Pausa propagada al receptor');

  // --- Archivo de audio --------------------------------------------------------
  const wav = path.join(os.tmpdir(), 'dualsound-e2e-tono.wav');
  makeWav(wav);
  await tx.setInputFiles('#host-file', wav);
  await tx.waitForFunction(() => window.dualsoundHost.track?.kind === 'file', null, { timeout: 10000 });
  await rx.waitForFunction(() => window.dualsoundReceiver.track?.ready && window.dualsoundReceiver.track.name === 'dualsound-e2e-tono', null, { timeout: 15000 });
  const decodedDuration = await rx.evaluate(() => window.dualsoundReceiver.player.duration);
  log(`Archivo transferido y decodificado en el receptor (${decodedDuration.toFixed(2)} s)`);
  assert.ok(Math.abs(decodedDuration - 8) < 0.01);
  await tx.click('#host-play');
  await rx.waitForFunction(() => window.dualsoundReceiver.player.playing, null, { timeout: 10000 });
  const fileErr = await sampleErrors(rx, () => window.dualsoundReceiver.player.lastError, 2500);
  const fileWorst = Math.max(...fileErr.map(Math.abs));
  log(`Archivo: peor error ${(fileWorst * 1000).toFixed(2)} ms`);
  assert.ok(fileWorst < 0.005);

  // --- Reconexión: el receptor recarga la página en mitad de la canción --------
  await rx.reload();
  await rx.click('#rx-unlock');
  await rx.waitForFunction(() => window.dualsoundReceiver?.player.playing, null, { timeout: 25000 });
  const after = await sampleErrors(rx, () => window.dualsoundReceiver.player.lastError, 1500);
  log(`Receptor reconectado y sumado a la canción en curso; peor error ${(Math.max(...after.map(Math.abs)) * 1000).toFixed(2)} ms`);
  assert.ok(Math.max(...after.map(Math.abs)) < 0.005);

  // --- Fin de la canción -------------------------------------------------------
  await tx.waitForFunction(() => !window.dualsoundHost.anchor, null, { timeout: 15000 });
  await rx.waitForFunction(() => !window.dualsoundReceiver.player.playing, null, { timeout: 5000 });
  log('Fin de la canción: ambos se detuvieron');

  // --- Interfaz ----------------------------------------------------------------
  const card = await tx.textContent('#receivers');
  assert.match(card, /Conectado/);
  await tx.setViewportSize({ width: 375, height: 812 });
  const overflow = await tx.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'sin desplazamiento horizontal en pantalla de iPhone');
  await tx.screenshot({ path: path.join(os.tmpdir(), 'dualsound-emisor.png'), fullPage: true });
  assert.equal(await rx.isVisible('#rx-unlock'), false, 'el botón Activar audio se oculta una vez activado');
  await rx.setViewportSize({ width: 375, height: 812 });
  await rx.screenshot({ path: path.join(os.tmpdir(), 'dualsound-receptor.png'), fullPage: true });

  const relevantErrors = pageErrors.filter((e) => !/favicon/.test(e));
  assert.deepEqual(relevantErrors, [], 'sin errores de JavaScript en las páginas');
  log('✅ Prueba de extremo a extremo superada');
} catch (e) {
  exitCode = 1;
  console.error('❌', e);
  if (pageErrors.length) console.error('Errores de página:', pageErrors);
} finally {
  await browser.close();
  server.close();
  peerServer.close?.();
  process.exit(exitCode);
}
