// Prueba de Mis Buses en Chromium: buscar un viaje en la red de ejemplo y
// crear una línea propia en el editor tocando el mapa.
//
//   cd web && npm install && npm run e2e:buses

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8767;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

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
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Sin internet en la prueba: los mosaicos del mapa no hacen falta.
  await page.route(/tile\.openstreetmap\.org|nominatim/, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${PORT}/buses.html`);

  // 1. Viaje con transbordo en la red de ejemplo.
  assert.ok(await page.isVisible('#example-note'));
  await page.fill('#from-input', 'Aeropuerto');
  await page.fill('#to-input', 'Terminal Norte');
  await page.click('#search');
  await page.waitForSelector('.option.selected');
  const first = await page.textContent('.option.selected');
  assert.match(first, /Línea 2/);
  assert.match(first, /\$ 1\.000/);
  assert.match(first, /1 transbordo/);
  assert.ok(await page.isVisible('#monthly'));
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/viaje.png`, fullPage: true });

  // Dos estudiantes: 2 × 40 % de 1.000.
  await page.fill('#passengers', '2');
  await page.selectOption('#profile', 'estudiante');
  await page.dispatchEvent('#passengers', 'change');
  assert.match(await page.textContent('.option.selected .option-fare'), /\$ 800/);

  // 2. Crear una línea propia tocando el mapa.
  await page.click('[data-tab="editar"]');
  await page.click('#e-new-line');
  await page.fill('#e-name', 'Ruta 99');
  await page.fill('#e-fare', '500');
  await page.click('#e-add-stops');
  await page.waitForTimeout(800); // espera el desplazamiento hasta el mapa
  const box = await page.locator('#map').boundingBox();
  for (const [x, y] of [[0.2, 0.3], [0.5, 0.5], [0.8, 0.7]]) {
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    await page.waitForSelector('#ask:not([hidden])');
    await page.fill('#ask-input', `Parada ${x}`);
    await page.click('#ask-ok');
  }
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/editor.png` });
  await page.click('#pick-cancel');
  assert.equal(await page.locator('#e-stops li').count(), 3);
  await page.click('#e-save-line');
  const net = await page.evaluate(() => window.misBuses.net);
  const line = net.lines.find((l) => l.name === 'Ruta 99');
  assert.ok(line, 'la línea nueva se guardó');
  assert.equal(line.stops.length, 3);
  assert.ok(await page.isHidden('#example-note'));

  // 3. Sigue guardada al recargar.
  await page.reload();
  const again = await page.evaluate(() => window.misBuses.net.lines.map((l) => l.name));
  assert.ok(again.includes('Ruta 99'));

  // 4. Pide la ubicación al abrir y el destino se elige tocando el mapa.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['geolocation'],
    geolocation: { latitude: -33.4289, longitude: -70.6693 }, // junto a "Hospital" en la red de ejemplo
  });
  const gp = await ctx.newPage();
  gp.on('pageerror', (e) => errors.push(e.message));
  await gp.route(/tile\.openstreetmap\.org|nominatim/, (r) => r.abort());
  await gp.goto(`http://127.0.0.1:${PORT}/buses.html`);
  await gp.waitForFunction(() => document.getElementById('from-input').value === 'Mi ubicación');
  await gp.evaluate(() => window.misBuses.map.setView([-33.4529, -70.6253], 15)); // cerca de "Centro Comercial"
  const mb = await gp.locator('#map').boundingBox();
  await gp.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await gp.waitForSelector('.option.selected');
  assert.match(await gp.getAttribute('#gmaps', 'href'), /google\.com\/maps\/dir\/.*travelmode=transit/);
  assert.match(await gp.getAttribute('#amaps', 'href'), /maps\.apple\.com\/.*dirflg=r/);
  if (process.env.SHOT_DIR) await gp.screenshot({ path: `${process.env.SHOT_DIR}/gps.png` });
  await ctx.close();

  assert.deepEqual(errors, []);
  console.log('OK: Mis Buses busca viajes, calcula precios y guarda rutas nuevas.');
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
