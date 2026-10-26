// Prueba de Ruta CR en Chromium: ubicación al abrir, buscar destino, ver
// opciones y detalle del viaje, tocar el mapa, rutas y ajustes.
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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

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
const shot = async (page, name) => { if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }); };

let exitCode = 0;
try {
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['geolocation'],
    geolocation: { latitude: 9.79726, longitude: -84.12143 }, // Terminal Los Mangos, San Gabriel de Aserrí
    locale: 'es-CR',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Sin internet en la prueba: mapas, fuentes y búsquedas externas no hacen falta.
  await page.route(/openstreetmap|arcgisonline|nominatim|googleapis|gstatic/, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${PORT}/buses.html`);

  // 1. Pide la ubicación al abrir y la usa como origen.
  await page.waitForFunction(() => window.rutaCR?.state.me);
  assert.equal(await page.inputValue('#from-input'), 'Tu ubicación');
  await page.waitForSelector('#tab-cerca [data-stop]');
  assert.match(await page.textContent('#tab-cerca'), /Los Mangos/);
  await shot(page, '1-inicio');

  // 2. Buscar el destino escribiendo y eligiendo una parada.
  await page.click('#to-input');
  await page.fill('#to-input', 'terminal en san');
  await page.waitForSelector('#suggestions:not([hidden]) [data-k]');
  await page.click('#suggestions [data-k]:has-text("Terminal en San José")');
  await page.waitForSelector('#view-results:not([hidden]) .option');
  const first = await page.textContent('#results .option');
  assert.match(first, /₡/);
  assert.match(first, /→/);
  await shot(page, '2-opciones');

  // 3. Detalle del viaje.
  await page.click('#results .option');
  await page.waitForSelector('#view-trip:not([hidden]) .timeline');
  const trip = await page.textContent('#trip');
  assert.match(trip, /Bájate en Terminal en San José/);
  assert.match(await page.getAttribute('#trip a[href*="google.com/maps"]', 'href'), /travelmode=transit/);
  await shot(page, '3-viaje');

  // 4. Adulto mayor: ruta de más de 25 km → paga la mitad.
  const fare = await page.textContent('.trip-sum .money');
  await page.click('#open-settings');
  await page.check('#set-senior');
  await page.click('#settings [data-close]');
  const half = await page.textContent('.trip-sum .money');
  const n = (s) => Number(s.replace(/\D/g, ''));
  assert.equal(n(half), Math.round(n(fare) / 2), `${fare} → ${half}`);

  // 5. Volver al inicio, ver una ruta con su horario.
  await page.click('#view-trip [data-back]');
  await page.click('#view-results [data-back]');
  await page.click('.segmented [data-tab="rutas"]');
  await page.click('[data-route="SGAB"]');
  await page.waitForSelector('#view-route:not([hidden]) .times span');
  assert.ok(await page.locator('#route .times span').count() > 10);
  await shot(page, '4-ruta');
  await page.click('#view-route [data-back]');

  // 6. Tocar el mapa elige el destino y busca solo.
  await page.evaluate(() => window.rutaCR.state.map.leaflet.setView([9.8616, -84.0731], 16));
  await page.waitForTimeout(300);
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2 + 40, box.y + 330);
  await page.waitForFunction(() => window.rutaCR.state.to && window.rutaCR.state.to.kind === 'place');
  await page.waitForSelector('#view-results:not([hidden])');

  // 7. Elegir el tipo de mapa: satélite, y Google pide la clave.
  await page.click('#layers');
  await page.click('[data-style="esri-sat"]');
  assert.equal(await page.evaluate(() => window.rutaCR.state.mapStyle), 'esri-sat');
  assert.ok(await page.locator('[data-style="google-road"][data-locked]').count());
  await page.click('[data-style="carto"]');
  assert.equal(await page.evaluate(() => window.rutaCR.state.mapStyle), 'carto');
  await shot(page, '6-tipos-de-mapa');
  await page.click('#layers');

  // 8. Todo el país: Heredia → San José con las rutas de ARESEP.
  await page.evaluate(() => {
    const { setPlace, search } = window.rutaCR;
    setPlace('from', { lat: 9.9986, lng: -84.1169, name: 'Parque de Heredia', kind: 'place' });
    setPlace('to', { lat: 9.9333, lng: -84.0796, name: 'Plaza de la Cultura', kind: 'place' });
    search();
  });
  await page.waitForSelector('#results .option', { timeout: 20000 });
  assert.match(await page.textContent('#results .option'), /→/);
  await shot(page, '7-heredia');

  // 9. Computadora: el panel queda a la izquierda.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  const sheet = await page.locator('#sheet').boundingBox();
  assert.ok(sheet.x < 40 && sheet.width < 420);
  await shot(page, '5-computadora');

  assert.deepEqual(errors, []);
  console.log('OK: Ruta CR pide la ubicación, busca viajes con horarios reales y muestra rutas.');
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
