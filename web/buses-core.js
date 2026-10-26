// Ruta CR: motor del planificador de viajes (lógica pura, sin interfaz).
//
// Trabaja con horarios reales (GTFS convertido por tools/gtfs-to-network.mjs):
// cada "recorrido" (pattern) tiene sus paradas en orden, los minutos desde la
// salida hasta cada parada y la lista de salidas de cada día.
//
// La búsqueda es por rondas (RAPTOR): ronda 1 = un bus, ronda 2 = un
// transbordo, etc. En cada ronda se guarda la llegada más temprana a cada
// parada. Después se calcula el pasaje de cada tramo según las zonas de la
// tarifa (mínima, media, completa), como las fija ARESEP.

export const WALK_KMH = 4.5;
/** Las calles no van en línea recta: distancia real ≈ 1,3 × la distancia en el mapa. */
export const DETOUR = 1.3;
export const DEFAULTS = {
  maxWalkM: 1000, // caminata máxima hasta la primera parada / desde la última
  transferWalkM: 300, // caminata máxima entre paradas para un transbordo
  maxBuses: 3,
  minTransferMin: 2, // margen mínimo para cambiar de bus
};

/** Distancia en metros entre dos puntos {lat, lng}. */
export function distanceM(a, b) {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Minutos caminando (por calles) entre dos puntos. */
export function walkMinutes(a, b) {
  return ((distanceM(a, b) * DETOUR) / 1000 / WALK_KMH) * 60;
}

/** Servicios (entresemana, sabado, domingo…) que funcionan ese día de la semana (0 = domingo). */
export function servicesFor(network, weekday) {
  return Object.entries(network.services || {}).filter(([, days]) => days.includes(weekday)).map(([id]) => id);
}

/** Salidas de un recorrido en un día, ordenadas (minutos desde medianoche). */
export function departuresOf(pattern, services) {
  const out = [];
  for (const s of services) out.push(...(pattern.trips[s] || []));
  return out.sort((a, b) => a - b);
}

/** Índice de la primera salida ≥ `t` (búsqueda binaria). */
function firstAtOrAfter(list, t) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Prepara índices que el planificador reutiliza (paradas cercanas, recorridos por parada). */
export function indexNetwork(network) {
  if (network._index) return network._index;
  const routeById = new Map(network.routes.map((r) => [r.id, r]));
  const patternsAtStop = network.stops.map(() => []);
  network.patterns.forEach((p, pi) => p.stops.forEach((s, i) => patternsAtStop[s].push([pi, i])));
  const nearby = network.stops.map((a, ai) => network.stops
    .map((b, bi) => ({ bi, m: distanceM(a, b) }))
    .filter((x) => x.bi !== ai && x.m <= DEFAULTS.transferWalkM));
  const index = { routeById, patternsAtStop, nearby };
  Object.defineProperty(network, '_index', { value: index, enumerable: false });
  return index;
}

/** Paradas a menos de `maxM` metros de un punto, de la más cercana a la más lejana. */
export function stopsNear(network, point, maxM) {
  return network.stops
    .map((stop, i) => ({ stop, i, meters: distanceM(point, stop) }))
    .filter((x) => x.meters <= maxM)
    .sort((a, b) => a.meters - b.meters);
}

/** Pasaje de un tramo según las zonas de subida y bajada. */
export function fareFor(network, routeId, fromStop, toStop) {
  const table = network.fares?.[routeId];
  if (!table) return null;
  const a = fromStop.zone;
  const b = toStop.zone;
  const v = table[`${a}|${b}`] ?? table[`${b}|${a}`];
  return v ?? Math.max(...Object.values(table));
}

/**
 * Beneficio de la persona adulta mayor (Ley 7935, art. 11): viaja gratis en
 * recorridos de menos de 25 km, paga 50 % entre 25 y 50 km y 75 % en más de 50 km.
 * `routeKm` es la longitud total del recorrido.
 */
export function seniorFactor(routeKm) {
  if (routeKm < 25) return 0;
  if (routeKm <= 50) return 0.5;
  return 0.75;
}

/**
 * Busca cómo ir de `from` a `to` ({lat, lng, name?}) saliendo a `departAt`
 * (minutos desde medianoche) un día `weekday` (0 = domingo).
 * Devuelve las opciones (una por cantidad de buses), cada una con sus tramos.
 */
export function planTrip(network, from, to, { departAt, weekday, ...options } = {}) {
  const opt = { ...DEFAULTS, ...options };
  const { routeById, nearby } = indexNetwork(network);
  const services = servicesFor(network, weekday);
  const deps = network.patterns.map((p) => departuresOf(p, services));
  const S = network.stops;

  // Ronda 0: caminar del origen a cada parada cercana.
  let prev = new Map();
  for (const { i, stop, meters } of stopsNear(network, from, opt.maxWalkM)) {
    const min = walkMinutes(from, stop);
    prev.set(i, { time: departAt + min, legs: [{ type: 'walk', from, to: stop, meters, minutes: min, start: departAt }], lastPattern: -1 });
  }

  const results = [];
  const best = new Map(prev); // mejor llegada a cada parada en cualquier ronda (para podar)

  for (let k = 1; k <= opt.maxBuses && prev.size; k += 1) {
    const cur = new Map();
    // Solo hace falta revisar recorridos que pasan por paradas alcanzadas en la ronda anterior.
    const queue = new Map();
    for (const stopIdx of prev.keys()) {
      for (const [pi, pos] of indexNetwork(network).patternsAtStop[stopIdx]) {
        if (!queue.has(pi) || queue.get(pi) > pos) queue.set(pi, pos);
      }
    }
    for (const [pi, startPos] of queue) {
      const p = network.patterns[pi];
      const list = deps[pi];
      if (!list.length) continue;
      let trip = null; // { start, board, boardPos, label }
      for (let pos = startPos; pos < p.stops.length; pos += 1) {
        const stopIdx = p.stops[pos];
        // Bajarse aquí.
        if (trip && pos > trip.boardPos) {
          const arr = trip.start + p.offsets[pos];
          const old = best.get(stopIdx);
          if (!old || arr < old.time - 1e-9) {
            const leg = {
              type: 'bus', route: routeById.get(p.route), pattern: p, headsign: p.headsign,
              from: S[trip.boardStop], to: S[stopIdx], boardPos: trip.boardPos, alightPos: pos,
              depart: trip.start + p.offsets[trip.boardPos], arrive: arr, stops: pos - trip.boardPos,
              km: +(p.dist[pos] - p.dist[trip.boardPos]).toFixed(1), tripStart: trip.start,
            };
            const label = { time: arr, legs: [...trip.label.legs, leg], lastPattern: pi };
            cur.set(stopIdx, label);
            best.set(stopIdx, label);
          }
        }
        // ¿Se puede tomar un bus más temprano aquí?
        const here = prev.get(stopIdx);
        if (here && here.lastPattern !== pi && pos < p.stops.length - 1) {
          const ready = here.time + (here.legs.length > 1 ? opt.minTransferMin : 0);
          const j = firstAtOrAfter(list, ready - p.offsets[pos]);
          if (j < list.length) {
            const start = list[j];
            if (!trip || start < trip.start) trip = { start, boardPos: pos, boardStop: stopIdx, label: here };
          }
        }
      }
    }

    // Transbordos caminando a una parada cercana.
    for (const [stopIdx, label] of [...cur]) {
      for (const { bi, m } of nearby[stopIdx]) {
        const min = walkMinutes(S[stopIdx], S[bi]);
        const t = label.time + min;
        const old = best.get(bi);
        if (!old || t < old.time - 1e-9) {
          const l2 = { time: t, legs: [...label.legs, { type: 'walk', from: S[stopIdx], to: S[bi], meters: m, minutes: min, start: label.time, transfer: true }], lastPattern: label.lastPattern };
          cur.set(bi, l2);
          best.set(bi, l2);
        }
      }
    }

    // ¿Alguna parada de esta ronda está cerca del destino?
    let bestHere = null;
    for (const [stopIdx, label] of cur) {
      const meters = distanceM(S[stopIdx], to);
      if (meters > opt.maxWalkM) continue;
      const min = walkMinutes(S[stopIdx], to);
      const arrive = label.time + min;
      if (!bestHere || arrive < bestHere.arrive) {
        bestHere = { arrive, legs: [...label.legs, { type: 'walk', from: S[stopIdx], to, meters, minutes: min, start: label.time }] };
      }
    }
    if (bestHere && (!results.length || bestHere.arrive < results.at(-1).arrive - 0.5)) results.push(finish(network, bestHere, departAt));
    prev = cur;
  }
  return results;
}

/** Completa una opción: totales, pasaje por tramo y caminata. */
function finish(network, r, departAt) {
  const legs = r.legs.filter((l) => l.type === 'bus' || l.meters > 25);
  const buses = legs.filter((l) => l.type === 'bus');
  for (const l of buses) {
    l.fare = fareFor(network, l.route.id, l.from, l.to);
    l.patternKm = l.pattern.dist.at(-1);
  }
  const walkM = legs.filter((l) => l.type === 'walk').reduce((s, l) => s + l.meters, 0);
  const fare = buses.reduce((s, l) => s + (l.fare || 0), 0);
  return {
    legs,
    depart: departAt,
    leaveAt: buses.length ? buses[0].depart - (legs[0].type === 'walk' ? legs[0].minutes : 0) : departAt,
    arrive: r.arrive,
    duration: r.arrive - departAt,
    fare,
    seniorFare: buses.reduce((s, l) => s + (l.fare || 0) * seniorFactor(l.patternKm), 0),
    buses: buses.length,
    transfers: Math.max(0, buses.length - 1),
    walkM,
    firstBus: buses[0] || null,
  };
}

/**
 * Varias opciones con buses distintos: la mejor ahora y las de los buses
 * siguientes (como "Próximo: 14:35 · luego 15:05").
 */
export function planOptions(network, from, to, { departAt, weekday, count = 4, ...options } = {}) {
  const out = [];
  const seen = new Set();
  let t = departAt;
  for (let i = 0; i < count * 3 && out.length < count; i += 1) {
    const found = planTrip(network, from, to, { departAt: t, weekday, ...options });
    if (!found.length) break;
    let nextT = Infinity;
    for (const o of found) {
      const key = o.legs.filter((l) => l.type === 'bus').map((l) => `${l.pattern.id}@${l.tripStart}`).join('|');
      if (o.firstBus) nextT = Math.min(nextT, o.firstBus.depart - (o.legs[0].type === 'walk' ? o.legs[0].minutes : 0) + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...o, depart: departAt, duration: o.arrive - departAt });
    }
    if (!Number.isFinite(nextT) || nextT >= departAt + 24 * 60) break;
    t = nextT;
  }
  out.sort((a, b) => a.arrive - b.arrive);
  return out.slice(0, count);
}

/** Próximas salidas en una parada: [{ route, headsign, time, pattern }]. */
export function nextDepartures(network, stopIdx, { now, weekday, limit = 6 } = {}) {
  const { routeById, patternsAtStop } = indexNetwork(network);
  const services = servicesFor(network, weekday);
  const out = [];
  for (const [pi, pos] of patternsAtStop[stopIdx]) {
    const p = network.patterns[pi];
    if (pos === p.stops.length - 1) continue; // es la última parada: ahí no se sube nadie
    for (const start of departuresOf(p, services)) {
      const time = start + p.offsets[pos];
      if (time >= now) out.push({ route: routeById.get(p.route), headsign: p.headsign, time, pattern: p });
    }
  }
  return out.sort((a, b) => a.time - b.time).slice(0, limit);
}

/** Rutas que pasan por una parada. */
export function routesAtStop(network, stopIdx) {
  const { routeById, patternsAtStop } = indexNetwork(network);
  return [...new Set(patternsAtStop[stopIdx].map(([pi]) => network.patterns[pi].route))].map((id) => routeById.get(id));
}

/** Horario de una ruta en un día: { headsign: [HH:MM...] } desde la primera parada. */
export function routeTimetable(network, routeId, weekday) {
  const services = servicesFor(network, weekday);
  const out = {};
  for (const p of network.patterns.filter((x) => x.route === routeId)) {
    const label = `${network.stops[p.stops[0]].name} → ${p.headsign}`;
    (out[label] ||= []).push(...departuresOf(p, services));
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort((a, b) => a - b);
  return out;
}

// ---------- Formatos ----------

/** Minutos desde medianoche → "2:35 p. m." (formato usado en Costa Rica). */
export function formatClock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** Duración legible: "45 min", "1 h 05 min". */
export function formatDuration(minutes) {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Distancia legible por calles: "350 m", "1,2 km". */
export function formatDistance(meters) {
  const m = meters * DETOUR;
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Colones: "₡1.085". */
export function formatColones(amount) {
  const n = Math.round(amount);
  return `₡${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/** "en 5 min", "ahora", "en 1 h 10 min". */
export function formatIn(minutes) {
  const m = Math.round(minutes);
  if (m <= 0) return 'ahora';
  return `en ${formatDuration(m)}`;
}

/** Texto para compartir un viaje. */
export function tripText(option, { from, to }) {
  const lines = [`🚌 ${from?.name || 'Origen'} → ${to?.name || 'Destino'}`];
  for (const l of option.legs) {
    if (l.type === 'walk') lines.push(`🚶 Caminar ${formatDistance(l.meters)} hasta ${l.to.name || 'el destino'}`);
    else lines.push(`🚏 ${formatClock(l.depart)} ${l.route.long} en ${l.from.name}; bajarse en ${l.to.name} (${formatClock(l.arrive)})`);
  }
  lines.push(`⏱ Llegada ${formatClock(option.arrive)} · 💵 ${formatColones(option.fare)}`);
  return lines.join('\n');
}
