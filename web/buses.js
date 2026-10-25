// Mis Buses: planificador de viajes en bus (lógica pura, sin interfaz).
//
// Modelo de red (todo lo pone el usuario en el editor, o viene del ejemplo):
//   stops: [{ id, name, lat, lng }]
//   lines: [{ id, name, color, fare, headwayMin, speedKmh, start, end,
//             stops: [ids en orden], circular?: bool, oneWay?: bool }]
//   transfer: { policy: 'full' | 'free' | 'fixed', amount, windowMin }
//   discounts: { estudiante: %, mayor: % }
//
// No hay horarios exactos: cada línea tiene una frecuencia ("pasa cada N min"),
// así que la espera estimada es la mitad de la frecuencia. El tiempo arriba del
// bus sale de la distancia entre paradas y la velocidad media de la línea.
//
// La búsqueda es por rondas (una ronda = un bus más, estilo RAPTOR). En cada
// parada se guardan los mejores viajes en tiempo Y precio (frente de Pareto),
// así aparece tanto la opción más rápida como la más barata.

export const WALK_KMH = 4.5;
/** Las calles no van en línea recta: distancia real ≈ 1,3 × la distancia en el mapa. */
export const DETOUR = 1.3;
export const DEFAULTS = {
  maxWalkM: 900, // caminata máxima hasta la primera parada / desde la última
  transferWalkM: 350, // caminata máxima entre dos paradas para hacer transbordo
  maxBuses: 3, // como máximo 3 buses (2 transbordos)
  transferPenaltyMin: 4, // un transbordo "molesta" como 4 min extra al ordenar
};
const MAX_LABELS = 6;

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
  return (distanceM(a, b) * DETOUR) / 1000 / WALK_KMH * 60;
}

/** Minutos de bus para recorrer `meters` en línea recta a `kmh`. */
export function rideMinutes(meters, kmh) {
  return (meters * DETOUR) / 1000 / Math.max(1, kmh) * 60;
}

/** Recorridos (secuencias de paradas) que hace una línea: ida y vuelta, o una sola si es circular/un sentido. */
export function patternsOf(line) {
  const ids = line.stops;
  if (line.circular) return [{ ids: [...ids, ids[0]], towards: line.end || line.name }];
  const out = [{ ids: [...ids], towards: line.end }];
  if (!line.oneWay) out.push({ ids: [...ids].reverse(), towards: line.start });
  return out;
}

/** Lo que cuesta subir a un bus, según cuántos buses llevas y cuánto ha pasado desde el primero. */
export function boardingFare(network, line, busesBefore, minutesSinceFirst) {
  if (busesBefore === 0) return line.fare;
  const t = network.transfer || { policy: 'full' };
  const inWindow = t.windowMin == null || minutesSinceFirst <= t.windowMin;
  if (t.policy === 'free' && inWindow) return 0;
  if (t.policy === 'fixed' && inWindow) return Math.min(line.fare, t.amount ?? line.fare);
  return line.fare;
}

/** Multiplicador de tarifa según el tipo de pasajero (descuento en %). */
export function discountFactor(network, profile) {
  const pct = network.discounts?.[profile] ?? 0;
  return Math.max(0, 1 - pct / 100);
}

/** "HH:MM" → minutos del día. */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutos del día → "HH:MM". */
export function formatClock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** ¿La línea está funcionando a esa hora del día? (acepta horarios que pasan medianoche). */
export function isRunning(line, minuteOfDay) {
  const a = parseClock(line.firstBus);
  const b = parseClock(line.lastBus);
  if (a == null || b == null) return true;
  const t = ((minuteOfDay % 1440) + 1440) % 1440;
  return a <= b ? t >= a && t <= b : t >= a || t <= b;
}

/** Duración legible: "45 min", "1 h 05 min". */
export function formatDuration(minutes) {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Distancia legible: "350 m", "1,2 km". */
export function formatDistance(meters) {
  const m = meters * DETOUR;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Precio legible con separador de miles: "$ 2.950". */
export function formatMoney(amount, currency = '$') {
  const rounded = Math.round(amount * 100) / 100;
  const [int, dec] = Math.abs(rounded).toFixed(rounded % 1 === 0 ? 0 : 2).split('.');
  const withDots = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${rounded < 0 ? '-' : ''}${currency} ${withDots}${dec ? `,${dec}` : ''}`;
}

/** Inserta una etiqueta en un frente de Pareto (tiempo, precio). Devuelve true si entró. */
function addLabel(set, label) {
  for (const o of set) {
    if (o.time <= label.time + 1e-9 && o.fare <= label.fare + 1e-9) return false;
  }
  for (let i = set.length - 1; i >= 0; i -= 1) {
    if (label.time <= set[i].time && label.fare <= set[i].fare) set.splice(i, 1);
  }
  set.push(label);
  if (set.length > MAX_LABELS) {
    set.sort((x, y) => x.time - y.time);
    set.length = MAX_LABELS;
  }
  return true;
}

/** Paradas a menos de `maxM` metros de un punto, con su distancia. */
export function stopsNear(network, point, maxM) {
  return network.stops
    .map((s) => ({ stop: s, meters: distanceM(point, s) }))
    .filter((x) => x.meters <= maxM)
    .sort((a, b) => a.meters - b.meters);
}

/**
 * Busca cómo ir de `from` a `to` (puntos {lat, lng, name?}).
 * Devuelve hasta 5 opciones ordenadas; cada una con sus tramos (`legs`),
 * tiempo total, precio, transbordos y distancia caminada.
 */
export function planTrip(network, from, to, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const departAt = opt.departAt ?? null; // minutos del día, para avisar si una línea no funciona
  const stopById = new Map(network.stops.map((s) => [s.id, s]));
  const lines = network.lines.filter((l) => l.stops.length >= 2 && l.stops.every((id) => stopById.has(id)));

  // Paradas cercanas entre sí (para transbordos a pie).
  const nearby = new Map();
  for (const s of network.stops) {
    nearby.set(s.id, stopsNear(network, s, opt.transferWalkM).filter((x) => x.stop.id !== s.id));
  }

  // Ronda 0: caminar desde el origen hasta cada parada cercana.
  let prev = new Map();
  for (const { stop, meters } of stopsNear(network, from, opt.maxWalkM)) {
    const min = walkMinutes(from, stop);
    prev.set(stop.id, [{
      time: min, fare: 0, buses: 0, firstBoard: null, walkM: meters, lastLine: null,
      legs: [{ type: 'walk', from: { ...from, name: from.name || 'Origen' }, to: stop, meters, minutes: min }],
    }]);
  }

  const finals = [];
  const collect = (round) => {
    for (const [stopId, labels] of round) {
      const s = stopById.get(stopId);
      const meters = distanceM(s, to);
      if (meters > opt.maxWalkM) continue;
      const min = walkMinutes(s, to);
      for (const l of labels) {
        if (l.buses === 0) continue;
        finals.push({
          ...l,
          time: l.time + min,
          walkM: l.walkM + meters,
          legs: [...l.legs, { type: 'walk', from: s, to: { ...to, name: to.name || 'Destino' }, meters, minutes: min }],
        });
      }
    }
  };

  for (let k = 1; k <= opt.maxBuses; k += 1) {
    const cur = new Map();
    const touched = new Set();

    for (const line of lines) {
      for (const pattern of patternsOf(line)) {
        let carried = []; // viajes que van arriba de este bus
        for (let i = 0; i < pattern.ids.length; i += 1) {
          const stopId = pattern.ids[i];
          const stop = stopById.get(stopId);
          if (i > 0) {
            const seg = rideMinutes(distanceM(stopById.get(pattern.ids[i - 1]), stop), line.speedKmh || 18);
            for (const c of carried) {
              c.time += seg;
              c.ride.stops += 1;
              c.ride.minutes += seg;
            }
            // Bajarse aquí.
            for (const c of carried) {
              const label = {
                time: c.time, fare: c.fare, buses: c.buses, firstBoard: c.firstBoard, walkM: c.walkM, lastLine: line.id,
                legs: [...c.legs, { ...c.ride, to: stop }],
              };
              if (!cur.has(stopId)) cur.set(stopId, []);
              if (addLabel(cur.get(stopId), label)) touched.add(stopId);
            }
          }
          // Subirse aquí (no en la última parada del recorrido).
          if (i < pattern.ids.length - 1) {
            for (const l of prev.get(stopId) || []) {
              if (l.lastLine === line.id) continue;
              const wait = (line.headwayMin || 10) / 2;
              const boardTime = l.time + wait;
              const firstBoard = l.firstBoard ?? boardTime;
              const fare = boardingFare(network, line, l.buses, boardTime - firstBoard);
              const warn = departAt != null && !isRunning(line, departAt + boardTime);
              const c = {
                time: boardTime, fare: l.fare + fare, buses: l.buses + 1, firstBoard, walkM: l.walkM, legs: l.legs,
                ride: {
                  type: 'bus', line, towards: pattern.towards, from: stop, stops: 0, minutes: 0,
                  waitMin: wait, fare, startAt: boardTime, notRunning: warn,
                },
              };
              // Solo seguir con él si no hay otro viaje en este bus igual o mejor.
              if (carried.some((o) => o.time <= c.time && o.fare <= c.fare)) continue;
              carried = carried.filter((o) => !(c.time <= o.time && c.fare <= o.fare));
              carried.push(c);
            }
          }
        }
      }
    }

    // Transbordos caminando a una parada cercana.
    for (const stopId of touched) {
      const from0 = stopById.get(stopId);
      for (const { stop, meters } of nearby.get(stopId)) {
        const min = walkMinutes(from0, stop);
        for (const l of cur.get(stopId)) {
          const label = {
            ...l, time: l.time + min, walkM: l.walkM + meters,
            legs: [...l.legs, { type: 'walk', from: from0, to: stop, meters, minutes: min, transfer: true }],
          };
          if (!cur.has(stop.id)) cur.set(stop.id, []);
          addLabel(cur.get(stop.id), label);
        }
      }
    }

    collect(cur);
    if (cur.size === 0) break;
    prev = cur;
  }

  // Caminar todo el camino, si es razonable.
  const direct = distanceM(from, to);
  if (direct <= 2500) {
    const min = walkMinutes(from, to);
    finals.push({
      time: min, fare: 0, buses: 0, walkM: direct,
      legs: [{ type: 'walk', from: { ...from, name: from.name || 'Origen' }, to: { ...to, name: to.name || 'Destino' }, meters: direct, minutes: min }],
    });
  }

  return rankOptions(finals, opt);
}

/** Puntaje para ordenar: tiempo + castigo por transbordo. */
export function score(o, opt = DEFAULTS) {
  return o.time + Math.max(0, o.buses - 1) * opt.transferPenaltyMin;
}

function rankOptions(finals, opt) {
  // Una opción por secuencia de líneas (la más rápida).
  const bestBySeq = new Map();
  for (const f of finals) {
    const legs = f.legs.filter((l) => l.type === 'bus');
    const key = legs.map((l) => `${l.line.id}:${l.from.id}>${l.to.id}`).join('|') || 'walk';
    const seqKey = legs.map((l) => l.line.id).join('|') || 'walk';
    const o = { ...f, transfers: Math.max(0, f.buses - 1), key, seqKey };
    const old = bestBySeq.get(seqKey);
    if (!old || score(o, opt) < score(old, opt)) bestBySeq.set(seqKey, o);
  }
  let list = [...bestBySeq.values()];
  // Quitar opciones claramente peores: más lentas, más caras y con más transbordos que otra.
  list = list.filter((o) => !list.some((p) => p !== o
    && p.time <= o.time && p.fare <= o.fare && p.transfers <= o.transfers
    && (p.time < o.time - 0.5 || p.fare < o.fare || p.transfers < o.transfers)));
  list.sort((a, b) => score(a, opt) - score(b, opt));
  return list.slice(0, 5);
}

/** Etiquetas para destacar opciones: la más rápida, la más barata, la de menos transbordos. */
export function badgesFor(options) {
  const out = new Map(options.map((o) => [o, []]));
  const withBus = options.filter((o) => o.buses > 0);
  if (!withBus.length) return out;
  const fastest = withBus.reduce((a, b) => (b.time < a.time ? b : a));
  const cheapest = withBus.reduce((a, b) => (b.fare < a.fare || (b.fare === a.fare && b.time < a.time) ? b : a));
  const fewest = withBus.reduce((a, b) => (b.transfers < a.transfers || (b.transfers === a.transfers && b.time < a.time) ? b : a));
  out.get(fastest).push('Más rápida');
  if (cheapest.fare < fastest.fare) out.get(cheapest).push('Más barata');
  if (fewest.transfers < fastest.transfers) out.get(fewest).push('Menos transbordos');
  return out;
}

/** Instrucciones paso a paso en texto. */
export function describeLeg(leg) {
  if (leg.type === 'walk') {
    const where = leg.to.name || 'destino';
    return `${leg.transfer ? 'Transbordo: camina' : 'Camina'} ${formatDistance(leg.meters)} (${formatDuration(leg.minutes)}) hasta ${where}`;
  }
  const n = leg.stops;
  return `Toma ${leg.line.name} dirección ${leg.towards} en ${leg.from.name}; bájate en ${leg.to.name} (${n} ${n === 1 ? 'parada' : 'paradas'}, ${formatDuration(leg.minutes)})`;
}

/** Resumen para compartir por WhatsApp, etc. */
export function tripText(option, network, { from, to, departAt, passengers = 1, profile = 'general' } = {}) {
  const f = discountFactor(network, profile);
  const lines = [`🚌 ${from?.name || 'Origen'} → ${to?.name || 'Destino'}`];
  option.legs.forEach((leg, i) => lines.push(`${i + 1}. ${describeLeg(leg)}`));
  lines.push(`⏱ ${formatDuration(option.time)}${departAt != null ? ` (llegas ~${formatClock(departAt + option.time)})` : ''}`);
  lines.push(`💵 ${formatMoney(option.fare * f * passengers, network.currency)}${passengers > 1 ? ` (${passengers} personas)` : ''}`);
  return lines.join('\n');
}

/** Gasto mensual: viajes por día × días por semana × 4,33 semanas. */
export function monthlyCost(fare, tripsPerDay, daysPerWeek) {
  return fare * tripsPerDay * daysPerWeek * (52 / 12);
}

/** Revisa una red importada; devuelve la lista de problemas (vacía si está bien). */
export function validateNetwork(net) {
  const errors = [];
  if (!net || typeof net !== 'object') return ['El archivo no es una red de buses.'];
  if (!Array.isArray(net.stops)) errors.push('Falta la lista de paradas ("stops").');
  if (!Array.isArray(net.lines)) errors.push('Falta la lista de líneas ("lines").');
  if (errors.length) return errors;
  const ids = new Set();
  for (const s of net.stops) {
    if (!s.id || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) errors.push(`Parada inválida: ${s.name || s.id || '?'}`);
    ids.add(s.id);
  }
  for (const l of net.lines) {
    if (!l.id || !l.name) errors.push('Hay una línea sin nombre.');
    if (!Array.isArray(l.stops) || l.stops.length < 2) errors.push(`La línea ${l.name || '?'} necesita al menos 2 paradas.`);
    else if (l.stops.some((id) => !ids.has(id))) errors.push(`La línea ${l.name} usa paradas que no existen.`);
    if (!(l.fare >= 0)) errors.push(`La línea ${l.name || '?'} no tiene precio.`);
  }
  return errors;
}

/** Id corto y único. */
export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
