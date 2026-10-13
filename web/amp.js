// Amplificador DualSound: sube el volumen percibido de canciones propias.
//
// Cadena de audio (Web Audio):
//   <audio> → graves (lowshelf) → ganancia (+dB) → compresor → limitador → medidor → salida
//
// - La ganancia sube todo el volumen.
// - El compresor acerca las partes suaves a las fuertes, así la canción suena
//   más fuerte en promedio sin pasarse del máximo.
// - El limitador final evita la saturación digital (el "crujido" al pasarse de
//   0 dB). No puede evitar que un parlante pequeño distorsione si se le piden
//   graves muy fuertes: para eso se puede bajar el control de graves.

/** Convierte decibeles a factor de ganancia. */
export function dbToGain(db) {
  return 10 ** (db / 20);
}

/** Nivel (dBFS) de un bloque de muestras: RMS y pico. */
export function measureLevel(samples) {
  let sum = 0;
  let peak = 0;
  for (const v of samples) {
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { rmsDb: toDb(rms), peakDb: toDb(peak) };
}

/** Porcentaje (0–100) para dibujar un medidor de -60 dB a 0 dB. */
export function meterPercent(db, floorDb = -60) {
  if (!Number.isFinite(db)) return 0;
  return Math.round(Math.min(1, Math.max(0, (db - floorDb) / -floorDb)) * 100);
}

export const MAX_BOOST_DB = 18;
export const MAX_BASS_DB = 12;

export const PRESETS = {
  normal: { boostDb: 0, bassDb: 0, compress: false },
  fuerte: { boostDb: 8, bassDb: 3, compress: true },
  maximo: { boostDb: 14, bassDb: 5, compress: true },
};

export class Amplifier {
  constructor(audioElement) {
    this.audio = audioElement;
    this.ctx = null;
    this.settings = { ...PRESETS.fuerte };
  }

  /** Crea la cadena de audio. Debe llamarse tras un toque del usuario. */
  async init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    // iOS 17+: que el modo silencio del iPhone no apague la música.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* no soportado */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'playback' });
    this.ctx = ctx;
    this.source = ctx.createMediaElementSource(this.audio);

    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 120;

    this.gain = ctx.createGain();

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.knee.value = 12;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.25;

    // Limitador: compresión muy fuerte justo debajo de 0 dB.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.meterBuffer = new Float32Array(this.analyser.fftSize);

    this.source.connect(this.bass);
    this.bass.connect(this.gain);
    this.gain.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.apply();
    if (ctx.state !== 'running') await ctx.resume();
  }

  set(changes) {
    this.settings = { ...this.settings, ...changes };
    this.apply();
  }

  apply() {
    if (!this.ctx) return;
    const { boostDb, bassDb, compress } = this.settings;
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(dbToGain(boostDb), t, 0.05);
    this.bass.gain.setTargetAtTime(bassDb, t, 0.05);
    // Sin compresión el compresor queda transparente (relación 1:1).
    this.compressor.ratio.setTargetAtTime(compress ? 4 : 1, t, 0.05);
    this.compressor.threshold.setTargetAtTime(compress ? -24 : 0, t, 0.05);
  }

  /** Nivel actual a la salida (después del limitador). */
  level() {
    if (!this.analyser) return { rmsDb: -Infinity, peakDb: -Infinity };
    this.analyser.getFloatTimeDomainData(this.meterBuffer);
    return measureLevel(this.meterBuffer);
  }

  /** Cuánto está bajando el limitador ahora mismo (dB, ≤ 0). */
  get limiting() {
    return this.limiter ? this.limiter.reduction : 0;
  }
}
