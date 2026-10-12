// DualSound Web — lógica de sincronización pura (sin DOM ni Web Audio).
// Es el equivalente en JavaScript de Core/ (DualSoundCore) de la app nativa.
// Se prueba con:  node --test web/test/

/** Versión del protocolo de mensajes entre emisor y receptores. */
export const PROTOCOL_VERSION = 1;

/** Tiempo entre pulsar Reproducir y el primer sonido (ms). */
export const START_LEAD_MS = 1200;

/** Margen mínimo para programar un arranque en el futuro (ms). */
export const START_MARGIN_MS = 400;

/** Tamaño de cada trozo al enviar un archivo por el canal de datos. */
export const FILE_CHUNK_BYTES = 64 * 1024;

/**
 * Estima el desfase entre el reloj del receptor y el del emisor con pings
 * estilo NTP. De las últimas mediciones usa la de menor ida y vuelta (RTT),
 * que es la menos afectada por las demoras variables del WiFi.
 * Todos los tiempos en milisegundos.
 */
export class ClockSync {
  constructor({ windowSize = 20, maxRoundTrip = 250, minSamples = 4 } = {}) {
    this.windowSize = windowSize;
    this.maxRoundTrip = maxRoundTrip;
    this.minSamples = minSamples;
    this.samples = [];
  }

  /** t0: envío del ping (local), t1/t2: llegada/salida en el emisor, t3: llegada de la respuesta (local). */
  static roundTrip({ t0, t1, t2, t3 }) {
    return (t3 - t0) - (t2 - t1);
  }

  /** Desfase = reloj del emisor − reloj local. */
  static offset({ t0, t1, t2, t3 }) {
    return ((t1 - t0) + (t2 - t3)) / 2;
  }

  /** Agrega una medición; devuelve false si se descartó. */
  add(sample) {
    const rtt = ClockSync.roundTrip(sample);
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > this.maxRoundTrip) return false;
    this.samples.push(sample);
    if (this.samples.length > this.windowSize) {
      this.samples.splice(0, this.samples.length - this.windowSize);
    }
    return true;
  }

  reset() {
    this.samples = [];
  }

  get isSynced() {
    return this.samples.length >= this.minSamples;
  }

  get best() {
    let best = null;
    for (const s of this.samples) {
      if (best === null || ClockSync.roundTrip(s) < ClockSync.roundTrip(best)) best = s;
    }
    return best;
  }

  /** Desfase (emisor − local) en ms, o null si aún no hay suficientes mediciones. */
  get offset() {
    return this.isSynced ? ClockSync.offset(this.best) : null;
  }

  get bestRoundTrip() {
    const b = this.best;
    return b ? ClockSync.roundTrip(b) : null;
  }
}

/**
 * Un "ancla" de reproducción: la posición `offset` (segundos dentro de la
 * pista) debe sonar en el instante `startHost` (ms, reloj del emisor). Desde
 * ahí la pista avanza en tiempo real.
 */
export function anchorPosition(anchor, hostTimeMs) {
  return anchor.offset + (hostTimeMs - anchor.startHost) / 1000;
}

/**
 * Decide cuándo y desde dónde empezar a sonar en un dispositivo.
 *
 * @param anchor     { startHost, offset }
 * @param hostNowMs  instante actual en el reloj del emisor
 * @param delayMs    retardo manual de este parlante (positivo = más tarde)
 * @returns { hostTime, position }: emitir `position` en `hostTime` (reloj del emisor)
 */
export function planStart(anchor, hostNowMs, { delayMs = 0, marginMs = START_MARGIN_MS } = {}) {
  // Si el ancla ya pasó (receptor que se suma tarde o resincronización),
  // se arranca un poco en el futuro, en la posición que corresponda.
  const reference = Math.max(anchor.startHost, hostNowMs + marginMs - delayMs);
  return { hostTime: reference + delayMs, position: anchorPosition(anchor, reference) };
}

/** Normaliza una posición dentro de una pista (con o sin repetición). */
export function wrapPosition(position, duration, loop) {
  if (!loop || !(duration > 0)) return position;
  return ((position % duration) + duration) % duration;
}

/**
 * Modelo de la posición de reproducción de un AudioBufferSourceNode cuando
 * se cambia su velocidad (playbackRate) para corregir la deriva.
 */
export class PlaybackModel {
  constructor() {
    this.active = false;
    this.startTime = 0;
    this.t = 0;
    this.p = 0;
    this.rate = 1;
  }

  /** Empieza a sonar `position` (s) en el instante `ctxTime` (s del AudioContext). */
  start(ctxTime, position, rate = 1) {
    this.active = true;
    this.startTime = ctxTime;
    this.t = ctxTime;
    this.p = position;
    this.rate = rate;
  }

  stop() {
    this.active = false;
  }

  positionAt(ctxTime) {
    return this.p + (ctxTime - this.t) * this.rate;
  }

  setRate(ctxTime, rate) {
    if (ctxTime > this.t) {
      this.p = this.positionAt(ctxTime);
      this.t = ctxTime;
    }
    this.rate = rate;
  }

  hasStarted(ctxTime) {
    return this.active && ctxTime >= this.startTime;
  }
}

/**
 * Corrige la deriva entre el reloj de audio y el reloj compartido.
 * Errores pequeños → ajuste de velocidad (±0,2 %, inaudible).
 * Errores grandes → resincronización (volver a programar el arranque).
 * El error está en segundos: positivo = el audio va adelantado.
 */
export class DriftController {
  constructor({
    deadband = 0.002,
    gain = 0.25,
    maxRateAdjustment = 0.002,
    hardResyncThreshold = 0.035,
    smoothing = 0.3,
  } = {}) {
    Object.assign(this, { deadband, gain, maxRateAdjustment, hardResyncThreshold, smoothing });
    this.reset();
  }

  reset() {
    this.smoothedError = null;
    this.rate = 1;
  }

  /** @returns {{ action: 'rate', rate: number } | { action: 'resync' }} */
  update(error) {
    if (!Number.isFinite(error)) return { action: 'rate', rate: this.rate };
    if (Math.abs(error) > this.hardResyncThreshold) {
      this.reset();
      return { action: 'resync' };
    }
    this.smoothedError = this.smoothedError === null
      ? error
      : this.smoothedError + this.smoothing * (error - this.smoothedError);
    if (Math.abs(this.smoothedError) < this.deadband) {
      this.rate = 1;
    } else {
      const adj = Math.min(Math.max(this.gain * this.smoothedError, -this.maxRateAdjustment), this.maxRateAdjustment);
      this.rate = 1 - adj;
    }
    return { action: 'rate', rate: this.rate };
  }
}

/** Clasifica la sincronía según el peor error medido (segundos). */
export function syncQuality(errors, { clockReady = true, playing = true } = {}) {
  if (!playing) return { level: 'idle', label: 'Detenido' };
  if (!clockReady) return { level: 'syncing', label: 'Sincronizando reloj…' };
  const measured = errors.filter((e) => Number.isFinite(e)).map(Math.abs);
  if (measured.length === 0) return { level: 'syncing', label: 'Midiendo…' };
  const worst = Math.max(...measured);
  if (worst < 0.005) return { level: 'good', label: 'Sincronizado', worst };
  if (worst < 0.02) return { level: 'fair', label: 'Ajustando', worst };
  return { level: 'poor', label: 'Desfasado', worst };
}

/** Divide un ArrayBuffer en trozos para enviarlo por el canal de datos. */
export function splitBuffer(buffer, chunkSize = FILE_CHUNK_BYTES) {
  const chunks = [];
  for (let i = 0; i < buffer.byteLength; i += chunkSize) {
    chunks.push(buffer.slice(i, Math.min(i + chunkSize, buffer.byteLength)));
  }
  return chunks;
}

/** Reensambla un archivo recibido en trozos (pueden llegar en cualquier orden). */
export class FileAssembler {
  constructor(id, size, count) {
    this.id = id;
    this.size = size;
    this.count = count;
    this.parts = new Array(count);
    this.received = 0;
    this.bytes = 0;
  }

  add(index, data) {
    if (index < 0 || index >= this.count || this.parts[index] !== undefined) return false;
    const bytes = data instanceof ArrayBuffer ? data : toArrayBuffer(data);
    this.parts[index] = bytes;
    this.received += 1;
    this.bytes += bytes.byteLength;
    return true;
  }

  get progress() {
    return this.count === 0 ? 1 : this.received / this.count;
  }

  get complete() {
    return this.received === this.count;
  }

  /** Devuelve el archivo completo, o lanza un error si está incompleto o corrupto. */
  assemble() {
    if (!this.complete) throw new Error('Archivo incompleto');
    if (this.bytes !== this.size) throw new Error(`Tamaño inesperado: ${this.bytes} de ${this.size} bytes`);
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      out.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return out.buffer;
  }
}

function toArrayBuffer(data) {
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new TypeError('Trozo de archivo con formato inválido');
}

/**
 * Genera la pista de calibración: un bip de 30 ms cada 0,5 s, más agudo cada
 * cuatro. Con los parlantes bien alineados se oye un solo clic; si no, eco.
 * Devuelve muestras mono en [-1, 1]. Su duración es múltiplo de 2 s para que
 * se repita sin cortes.
 */
export function renderClickTrack(sampleRate, seconds = 60) {
  const beat = 0.5;
  const beep = 0.03;
  const ramp = 0.002;
  const total = Math.round(sampleRate * seconds);
  const out = new Float32Array(total);
  const beatFrames = Math.round(sampleRate * beat);
  const beepFrames = Math.round(sampleRate * beep);
  for (let start = 0, n = 0; start < total; start += beatFrames, n += 1) {
    const freq = n % 4 === 0 ? 1760 : 880;
    for (let i = 0; i < beepFrames && start + i < total; i += 1) {
      const t = i / sampleRate;
      const env = Math.min(1, t / ramp, (beep - t) / ramp);
      out[start + i] = Math.sin(2 * Math.PI * freq * t) * env * 0.6;
    }
  }
  return out;
}

/** Código de emparejamiento de 6 dígitos (sin ceros iniciales ambiguos). */
export function makePairingCode(random = Math.random) {
  return String(100000 + Math.floor(random() * 900000));
}

/** Identificador PeerJS de un receptor a partir de su código. */
export function peerIdForCode(code) {
  return `dualsound-v${PROTOCOL_VERSION}-${String(code).replace(/\D/g, '')}`;
}

export function formatMs(seconds, { signed = false, digits = 1 } = {}) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const ms = seconds * 1000;
  const text = ms.toFixed(digits).replace('.', ',');
  return `${signed && ms >= 0 ? '+' : ''}${text} ms`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
