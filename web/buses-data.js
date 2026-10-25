// Red de EJEMPLO para probar Mis Buses. Las líneas, paradas y precios son
// inventados: en la página se reemplazan por los de tu ciudad desde "Mis rutas".

const C = { lat: -33.4489, lng: -70.6693 };
const at = (dLat, dLng) => ({ lat: +(C.lat + dLat).toFixed(5), lng: +(C.lng + dLng).toFixed(5) });

const stops = [
  ['terminal-norte', 'Terminal Norte', 0.030, 0.000],
  ['hospital', 'Hospital', 0.020, 0.000],
  ['mercado', 'Mercado', 0.010, 0.000],
  ['plaza', 'Plaza Central', 0.000, 0.000],
  ['estadio', 'Estadio', -0.010, 0.000],
  ['terminal-sur', 'Terminal Sur', -0.022, 0.002],
  ['aeropuerto', 'Aeropuerto', 0.004, -0.045],
  ['industrial', 'Zona Industrial', 0.002, -0.030],
  ['oeste', 'Barrio Oeste', 0.000, -0.016],
  ['catedral', 'Catedral', 0.000, 0.008],
  ['universidad', 'Universidad', 0.000, 0.020],
  ['parque', 'Parque', -0.002, 0.032],
  ['mall', 'Centro Comercial', -0.004, 0.044],
  ['colegio', 'Colegio', 0.012, 0.018],
  ['clinica', 'Clínica', -0.012, 0.022],
  ['villa', 'Villa Esperanza', -0.020, 0.030],
].map(([id, name, dLat, dLng]) => ({ id, name, ...at(dLat, dLng) }));

export const EXAMPLE_NETWORK = {
  name: 'Ciudad de ejemplo',
  example: true,
  currency: '$',
  center: [C.lat, C.lng],
  zoom: 13,
  // Pagas cada bus, pero el transbordo dentro de 60 min cuesta solo $ 200.
  transfer: { policy: 'fixed', amount: 200, windowMin: 60 },
  discounts: { estudiante: 60, mayor: 50 },
  stops,
  lines: [
    {
      id: 'l1', name: 'Línea 1', color: '#e63946', fare: 800, headwayMin: 8, speedKmh: 20,
      start: 'Terminal Norte', end: 'Terminal Sur', firstBus: '05:30', lastBus: '23:00',
      stops: ['terminal-norte', 'hospital', 'mercado', 'plaza', 'estadio', 'terminal-sur'],
    },
    {
      id: 'l2', name: 'Línea 2', color: '#1d6fdc', fare: 800, headwayMin: 12, speedKmh: 18,
      start: 'Aeropuerto', end: 'Centro Comercial', firstBus: '06:00', lastBus: '22:30',
      stops: ['aeropuerto', 'industrial', 'oeste', 'plaza', 'catedral', 'universidad', 'parque', 'mall'],
    },
    {
      id: 'l3', name: 'Línea 3 (expreso)', color: '#2a9d8f', fare: 1200, headwayMin: 15, speedKmh: 30,
      start: 'Terminal Norte', end: 'Villa Esperanza', firstBus: '06:00', lastBus: '21:00',
      stops: ['terminal-norte', 'colegio', 'universidad', 'clinica', 'villa'],
    },
    {
      id: 'c1', name: 'Circular Centro', color: '#f4a261', fare: 600, headwayMin: 10, speedKmh: 16,
      start: 'Plaza Central', end: 'Plaza Central', circular: true, firstBus: '06:30', lastBus: '21:30',
      stops: ['plaza', 'mercado', 'colegio', 'universidad', 'clinica', 'estadio'],
    },
  ],
};
