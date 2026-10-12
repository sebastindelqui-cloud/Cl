// DualSound Web — emisor y receptor en una sola página.
//
// Flujo:
//  1. El receptor crea un "peer" PeerJS con un código de 6 dígitos.
//  2. El emisor se conecta a ese código (WebRTC, directo por la red local).
//  3. El emisor envía el archivo de audio completo; cada teléfono lo decodifica.
//  4. El receptor sincroniza su reloj con el del emisor (pings estilo NTP).
//  5. El emisor publica un ancla: "la posición X suena en el instante T"
//     (reloj del emisor). Cada teléfono programa el audio con Web Audio para
//     sonar en ese instante y corrige la deriva continuamente.
// Ver docs/WEB.md para el protocolo completo.

import * as S from './sync.js';

const Peer = window.Peer;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opciones del servidor de emparejamiento. Por defecto, el servidor público
 *  gratuito de PeerJS; ?peerHost=…&peerPort=…&peerSecure=0 permite usar uno
 *  propio (se usa en las pruebas automáticas). */
function peerOptions() {
  const q = new URLSearchParams(location.search);
  const options = { debug: 1 };
  if (q.get('peerHost')) {
    options.host = q.get('peerHost');
    options.port = Number(q.get('peerPort') || 443);
    options.path = q.get('peerPath') || '/';
    options.secure = q.get('peerSecure') !== '0';
  }
  return options;
}

const PEER_ERRORS = {
  'browser-incompatible': 'Este navegador no soporta WebRTC. Usa Safari (iPhone) o Chrome (Android) actualizados.',
  'network': 'No se pudo contactar el servidor de emparejamiento. Revisa la conexión a internet.',
  'server-error': 'El servidor de emparejamiento no responde. Intenta de nuevo en un momento.',
  'socket-error': 'Se perdió la conexión con el servidor de emparejamiento.',
  'socket-closed': 'Se perdió la conexión con el servidor de emparejamiento.',
  'peer-unavailable': 'No se encontró ese receptor. Revisa el código y que la página del receptor siga abierta.',
  'unavailable-id': 'Ese código ya está en uso.',
  'webrtc': 'Falló la conexión directa entre los teléfonos. Comprueba que estén en el mismo WiFi.',
};

function describePeerError(err) {
  return PEER_ERRORS[err?.type] || err?.message || String(err);
}

/** Mantiene la pantalla encendida mientras la página está visible. */
const wakeLock = {
  sentinel: null,
  wanted: false,
  async enable() {
    this.wanted = true;
    if (!('wakeLock' in navigator) || this.sentinel) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => { this.sentinel = null; });
    } catch {
      // Sin permiso o no soportado: se muestra el aviso de dejar la pantalla encendida.
    }
  },
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock.wanted) wakeLock.enable();
});

// ---------------------------------------------------------------------------
// Reproductor sincronizado (lo usan el emisor y el receptor)
// ---------------------------------------------------------------------------

class SyncedPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.loop = false;
    this.source = null;
    this.anchor = null;
    this.model = new S.PlaybackModel();
    this.drift = new S.DriftController();
    /** Devuelve el desfase (reloj del emisor − reloj local, ms) o null. */
    this.clockOffset = () => 0;
    this.delayMs = 0;
    this.volume = 1;
    this.muted = false;
    this.lastError = null;
    this.ended = false;
    this.onEnded = null;
    setInterval(() => this.tick(), 500);
  }

  /** Crea el AudioContext (sin sonido todavía). */
  ensureContext() {
    if (this.ctx) return this.ctx;
    // iOS 17+: que el modo silencio del iPhone no apague la música.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* no soportado */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.applyVolume();
    return this.ctx;
  }

  /** Debe llamarse desde un toque del usuario: los navegadores móviles no
   *  dejan sonar audio sin un gesto. */
  async unlock() {
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') await ctx.resume();
    // Un búfer silencioso termina de "desbloquear" el audio en iOS.
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start();
    wakeLock.enable();
    return ctx.state === 'running';
  }

  get unlocked() {
    return this.ctx?.state === 'running';
  }

  async decode(bytes) {
    const ctx = this.ensureContext();
    // decodeAudioData "consume" el ArrayBuffer: se decodifica una copia.
    return new Promise((resolve, reject) => {
      const copy = bytes.slice(0);
      const p = ctx.decodeAudioData(copy, resolve, (e) => reject(e || new Error('formato no soportado')));
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  makeClickBuffer() {
    const ctx = this.ensureContext();
    const samples = S.renderClickTrack(ctx.sampleRate, 60);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  setTrack(buffer, loop) {
    this.stop();
    this.buffer = buffer;
    this.loop = loop;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  // --- Relación entre el reloj de audio y performance.now() -----------------

  outputTimestamp() {
    if (!this.ctx?.getOutputTimestamp) return null;
    const ts = this.ctx.getOutputTimestamp();
    return ts && ts.contextTime > 0 && ts.performanceTime > 0 ? ts : null;
  }

  /** Latencia de salida que informa el navegador (s). */
  get reportedLatency() {
    if (!this.ctx) return null;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  /** Instante del AudioContext en que *sale por el parlante* el audio
   *  correspondiente al instante `perfMs` de performance.now(). */
  perfToCtx(perfMs) {
    const ts = this.outputTimestamp();
    if (ts) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    return this.ctx.currentTime + (perfMs - now()) / 1000 - this.reportedLatency;
  }

  ctxToPerf(ctxTime) {
    const ts = this.outputTimestamp();
    if (ts) return ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
    return now() + (ctxTime - this.ctx.currentTime + this.reportedLatency) * 1000;
  }

  // --- Reproducción ----------------------------------------------------------

  play(anchor) {
    this.anchor = anchor;
    this.ended = false;
    this.startFromAnchor();
  }

  stop() {
    this.anchor = null;
    this.stopSource();
  }

  setDelay(ms) {
    if (ms === this.delayMs) return;
    this.delayMs = ms;
    if (this.anchor) this.startFromAnchor();
  }

  setVolume(volume) {
    this.volume = volume;
    this.applyVolume();
  }

  setMuted(muted) {
    this.muted = muted;
    this.applyVolume();
  }

  applyVolume() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  stopSource() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* ya detenido */ }
      this.source.disconnect();
      this.source = null;
    }
    this.model.stop();
    this.drift.reset();
    this.lastError = null;
  }

  /** (Re)programa el audio según el ancla, el reloj y el retardo actuales. */
  startFromAnchor() {
    this.stopSource();
    if (!this.anchor || !this.buffer || !this.unlocked) return false;
    const offset = this.clockOffset();
    if (offset === null) return false; // Aún sin reloj: se reintenta en tick().

    const plan = S.planStart(this.anchor, now() + offset, { delayMs: this.delayMs });
    if (!this.loop && plan.position >= this.buffer.duration) {
      this.markEnded();
      return false;
    }
    const position = S.wrapPosition(plan.position, this.buffer.duration, this.loop);
    const when = this.perfToCtx(plan.hostTime - offset);
    if (when <= this.ctx.currentTime) return false;

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = this.loop;
    source.connect(this.gain);
    source.onended = () => {
      if (this.source === source) this.markEnded();
    };
    source.start(when, position);
    this.source = source;
    this.model.start(when, position);
    return true;
  }

  markEnded() {
    this.stopSource();
    this.anchor = null;
    if (!this.ended) {
      this.ended = true;
      this.onEnded?.();
    }
  }

  /** Mide el error cada 0,5 s y corrige la deriva. */
  tick() {
    if (!this.anchor || !this.ctx) return;
    const offset = this.clockOffset();
    if (offset === null) return;
    if (!this.source) {
      this.startFromAnchor();
      return;
    }
    const c = this.ctx.currentTime;
    if (!this.model.hasStarted(c)) return;

    const hostTimeAtOutput = this.ctxToPerf(c) + offset;
    const expected = S.anchorPosition(this.anchor, hostTimeAtOutput - this.delayMs);
    let error = this.model.positionAt(c) - expected;
    if (this.loop && this.buffer) {
      const d = this.buffer.duration;
      error -= d * Math.round(error / d);
    }
    this.lastError = error;

    const decision = this.drift.update(error);
    if (decision.action === 'resync') {
      this.startFromAnchor();
    } else if (Math.abs(decision.rate - this.model.rate) > 1e-6) {
      this.source.playbackRate.value = decision.rate;
      this.model.setRate(c, decision.rate);
    }
  }

  get playing() {
    return !!this.source && this.model.hasStarted(this.ctx.currentTime);
  }

  get rate() {
    return this.model.active ? this.model.rate : 1;
  }
}

// ---------------------------------------------------------------------------
// Controles reutilizables
// ---------------------------------------------------------------------------

/** Control de volumen + retardo. El retardo se aplica al soltar el control
 *  (cada cambio reprograma el audio). */
function createControls(container, { volume, delayMs, onVolume, onDelay }) {
  container.innerHTML = `
    <div class="control">
      <div class="control-head"><span>Volumen</span><span class="value vol-value"></span></div>
      <input type="range" class="vol" min="0" max="1" step="0.01" aria-label="Volumen">
    </div>
    <div class="control">
      <div class="control-head">
        <span>Retardo</span>
        <button type="button" class="minus" aria-label="Restar 5 ms">−5</button>
        <button type="button" class="plus" aria-label="Sumar 5 ms">+5</button>
        <span class="value delay-value"></span>
      </div>
      <input type="range" class="delay" min="-100" max="400" step="1" aria-label="Retardo en milisegundos">
    </div>`;
  const vol = container.querySelector('.vol');
  const delay = container.querySelector('.delay');
  const volValue = container.querySelector('.vol-value');
  const delayValue = container.querySelector('.delay-value');
  const show = () => {
    volValue.textContent = `${Math.round(vol.value * 100)} %`;
    delayValue.textContent = S.formatMs(delay.value / 1000, { signed: true, digits: 0 });
  };
  vol.value = volume;
  delay.value = delayMs;
  show();
  vol.addEventListener('input', () => { show(); onVolume(Number(vol.value)); });
  delay.addEventListener('input', show);
  delay.addEventListener('change', () => onDelay(Number(delay.value)));
  const step = (d) => {
    delay.value = Math.min(400, Math.max(-100, Number(delay.value) + d));
    show();
    onDelay(Number(delay.value));
  };
  container.querySelector('.minus').addEventListener('click', () => step(-5));
  container.querySelector('.plus').addEventListener('click', () => step(5));
}

function renderQuality(el, quality) {
  el.className = `quality ${quality.level}`;
  el.querySelector('.label').textContent = quality.label;
  el.querySelector('.worst').textContent = quality.worst !== undefined ? `peor error ${S.formatMs(quality.worst)}` : '';
}

function renderMessages(card, list, messages) {
  card.hidden = messages.length === 0;
  list.innerHTML = '';
  for (const m of messages) {
    const li = document.createElement('li');
    li.textContent = m;
    list.appendChild(li);
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh.*Mobile/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'Navegador';
}

// ---------------------------------------------------------------------------
// Emisor
// ---------------------------------------------------------------------------

class Host {
  constructor() {
    this.player = new SyncedPlayer();
    this.player.clockOffset = () => 0; // El emisor es la referencia de reloj.
    this.player.onEnded = () => this.handleEnded();
    this.peer = null;
    this.peerError = null;
    this.receivers = new Map(); // código → estado
    this.track = null; // { id, kind, name, bytes, buffer, loop }
    this.anchor = null;
    this.pausedAt = 0;
    this.messages = [];
    this.trackCounter = 0;
  }

  start() {
    if (this.peer) return;
    this.peer = new Peer(undefined, peerOptions());
    this.peer.on('open', () => { this.peerError = null; });
    this.peer.on('disconnected', () => {
      // Se perdió el servidor de emparejamiento; las conexiones directas siguen.
      setTimeout(() => { if (!this.peer.destroyed) this.peer.reconnect(); }, 2000);
    });
    this.peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        const code = String(err.message || '').match(/(\d{6})/)?.[1];
        const r = code && this.receivers.get(code);
        if (r) { r.state = 'not-found'; return; }
      }
      this.peerError = describePeerError(err);
    });
  }

  // --- Receptores --------------------------------------------------------------

  addReceiver(rawCode) {
    const code = String(rawCode).replace(/\D/g, '');
    if (code.length !== 6) {
      this.flash('El código tiene 6 números.');
      return;
    }
    if (this.receivers.has(code)) return;
    const r = {
      code, name: `Receptor ${code}`, conn: null, state: 'connecting', status: null,
      volume: 1, delayMs: 0, removed: false, sentTrackId: null, readyTrackId: null,
      transferProgress: 0, attempts: 0, card: null,
    };
    this.receivers.set(code, r);
    this.connect(r);
  }

  connect(r) {
    if (r.removed) return;
    if (!this.peer?.open) {
      setTimeout(() => this.connect(r), 500);
      return;
    }
    r.attempts += 1;
    r.state = r.attempts > 1 ? 'reconnecting' : 'connecting';
    const conn = this.peer.connect(S.peerIdForCode(r.code), { reliable: true, serialization: 'binary' });
    r.conn = conn;
    conn.on('open', () => {
      conn.send({ t: 'hello', v: S.PROTOCOL_VERSION, name: deviceName() });
    });
    conn.on('data', (msg) => this.handle(r, conn, msg, now()));
    const closed = () => {
      if (r.conn !== conn) return;
      r.conn = null;
      r.status = null;
      r.sentTrackId = null;
      r.readyTrackId = null;
      if (r.removed) return;
      if (r.state !== 'not-found') r.state = 'reconnecting';
      // Reintenta con espera creciente (2, 4, 8… hasta 15 s).
      const wait = Math.min(15000, 1000 * 2 ** Math.min(r.attempts, 4));
      setTimeout(() => { if (!r.removed && !r.conn) this.connect(r); }, wait);
    };
    conn.on('close', closed);
    conn.on('error', closed);
    // PeerJS no siempre avisa si el receptor no existe: tiempo máximo de espera.
    setTimeout(() => { if (r.conn === conn && !conn.open) { conn.close(); closed(); } }, 12000);
  }

  removeReceiver(code) {
    const r = this.receivers.get(code);
    if (!r) return;
    r.removed = true;
    try { r.conn?.send({ t: 'stop' }); } catch { /* ignorar */ }
    setTimeout(() => r.conn?.close(), 200);
    r.card?.remove();
    this.receivers.delete(code);
  }

  send(r, msg) {
    if (r.conn?.open) r.conn.send(msg);
  }

  handle(r, conn, msg, arrival) {
    if (r.conn !== conn || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'helloAck':
        if (msg.v !== S.PROTOCOL_VERSION) {
          r.state = 'incompatible';
          conn.close();
          return;
        }
        r.state = 'connected';
        r.attempts = 0;
        r.name = msg.name || r.name;
        this.send(r, { t: 'settings', volume: r.volume, delayMs: r.delayMs });
        if (this.track) this.sendTrack(r);
        break;
      case 'ping':
        // t1 = llegada del ping; t2 = salida de la respuesta.
        this.send(r, { t: 'pong', id: msg.id, t0: msg.t0, t1: arrival, t2: now() });
        break;
      case 'progress':
        if (msg.id === this.track?.id) r.transferProgress = msg.progress;
        break;
      case 'ready':
        r.readyTrackId = msg.id;
        if (this.anchor && msg.id === this.track?.id) {
          this.send(r, { t: 'play', id: msg.id, anchor: this.anchor });
        }
        break;
      case 'status':
        r.status = msg;
        break;
      case 'error':
        this.flash(`${r.name}: ${msg.message}`);
        break;
      default:
        break;
    }
  }

  /** Envía la pista a un receptor, respetando el búfer del canal de datos. */
  async sendTrack(r) {
    const track = this.track;
    const conn = r.conn;
    if (!track || !conn?.open || r.sentTrackId === track.id) return;
    r.sentTrackId = track.id;
    r.readyTrackId = null;
    r.transferProgress = 0;
    if (track.kind === 'click') {
      this.send(r, { t: 'track', id: track.id, kind: 'click', name: track.name });
      return;
    }
    const chunks = S.splitBuffer(track.bytes);
    this.send(r, { t: 'track', id: track.id, kind: 'file', name: track.name, size: track.bytes.byteLength, count: chunks.length });
    for (let i = 0; i < chunks.length; i += 1) {
      // Si cambió la pista o se cortó la conexión, se abandona el envío.
      if (this.track !== track || r.conn !== conn || !conn.open) return;
      while ((conn.dataChannel?.bufferedAmount || 0) > 1_000_000) {
        await sleep(20);
        if (r.conn !== conn || !conn.open) return;
      }
      conn.send({ t: 'chunk', id: track.id, i, data: chunks[i] });
      if (i % 8 === 7) await sleep(0);
    }
  }

  // --- Pistas ----------------------------------------------------------------

  async loadFile(file) {
    this.player.ensureContext();
    let bytes;
    let buffer;
    try {
      bytes = await file.arrayBuffer();
      buffer = await this.player.decode(bytes);
    } catch (e) {
      this.flash(`No se pudo leer «${file.name}»: el formato no es compatible con este navegador o el archivo está protegido.`);
      return;
    }
    this.setTrack({ kind: 'file', name: file.name.replace(/\.[^.]+$/, ''), bytes, buffer, loop: false });
  }

  loadClickTrack() {
    this.setTrack({ kind: 'click', name: 'Pista de calibración (clics)', buffer: this.player.makeClickBuffer(), loop: true });
  }

  setTrack(track) {
    this.pause();
    this.trackCounter += 1;
    this.track = { ...track, id: `${Date.now().toString(36)}-${this.trackCounter}` };
    this.pausedAt = 0;
    this.player.setTrack(track.buffer, track.loop);
    for (const r of this.receivers.values()) this.sendTrack(r);
  }

  // --- Transporte ------------------------------------------------------------

  async play() {
    if (!this.track || this.anchor) return;
    if (!(await this.player.unlock())) {
      this.flash('El navegador no permitió activar el audio. Toca ▶︎ otra vez.');
      return;
    }
    this.anchor = { startHost: now() + S.START_LEAD_MS, offset: this.pausedAt };
    this.player.play(this.anchor);
    for (const r of this.receivers.values()) {
      if (r.readyTrackId === this.track.id) this.send(r, { t: 'play', id: this.track.id, anchor: this.anchor });
    }
  }

  pause() {
    if (!this.anchor) return;
    const pos = Math.max(this.anchor.offset, S.anchorPosition(this.anchor, now()));
    this.pausedAt = this.track
      ? (this.track.loop ? S.wrapPosition(pos, this.player.duration, true) : Math.min(pos, this.player.duration))
      : 0;
    this.anchor = null;
    this.player.stop();
    for (const r of this.receivers.values()) this.send(r, { t: 'stop' });
  }

  handleEnded() {
    // Terminó la canción en el emisor: todos se detienen y vuelve al inicio.
    if (!this.anchor) return;
    this.anchor = null;
    this.pausedAt = 0;
    for (const r of this.receivers.values()) this.send(r, { t: 'stop' });
  }

  get position() {
    if (!this.anchor) return this.pausedAt;
    const pos = Math.max(this.anchor.offset, S.anchorPosition(this.anchor, now()));
    return this.track?.loop ? S.wrapPosition(pos, this.player.duration, true) : Math.min(pos, this.player.duration);
  }

  flash(message) {
    this.messages = [message, ...this.messages.filter((m) => m !== message)].slice(0, 4);
  }
}

// ---------------------------------------------------------------------------
// Receptor
// ---------------------------------------------------------------------------

class Receiver {
  constructor() {
    this.player = new SyncedPlayer();
    this.clock = new S.ClockSync();
    this.player.clockOffset = () => this.clock.offset;
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.state = 'starting';
    this.hostName = null;
    this.track = null; // { id, kind, name }
    this.assembler = null;
    this.pendingPlay = null;
    this.pingTimer = null;
    this.pingId = 0;
    this.messages = [];
    this.idRetries = 0;
    setInterval(() => this.sendStatus(), 1000);
  }

  start() {
    if (this.peer) return;
    let code = null;
    try { code = localStorage.getItem('dualsound.code'); } catch { /* sin almacenamiento */ }
    this.openPeer(code || S.makePairingCode());
  }

  openPeer(code) {
    this.code = code;
    try { localStorage.setItem('dualsound.code', code); } catch { /* sin almacenamiento */ }
    this.state = 'starting';
    const peer = new Peer(S.peerIdForCode(code), peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      this.state = this.conn?.open ? 'connected' : 'waiting';
      this.idRetries = 0;
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // Suele ser esta misma página recién recargada: el servidor tarda en
        // liberar el código. Se reintenta; si sigue ocupado, se usa otro.
        peer.destroy();
        this.idRetries += 1;
        const next = this.idRetries > 4 ? S.makePairingCode() : code;
        if (this.idRetries > 4) this.idRetries = 0;
        setTimeout(() => this.openPeer(next), 3000);
        this.state = 'starting';
        return;
      }
      this.flash(describePeerError(err));
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) this.state = 'offline';
    });
  }

  accept(conn) {
    // Un emisor nuevo (o el mismo, reconectado) reemplaza al anterior.
    if (this.conn && this.conn !== conn) this.conn.close();
    this.conn = conn;
    conn.on('data', (msg) => this.handle(conn, msg, now()));
    const closed = () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.state = 'waiting';
      this.flash('El emisor se desconectó. Esperando que se vuelva a conectar…');
      clearInterval(this.pingTimer);
      this.clock.reset();
      this.player.stop();
    };
    conn.on('close', closed);
    conn.on('error', closed);
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  async handle(conn, msg, arrival) {
    if (conn !== this.conn || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        if (msg.v !== S.PROTOCOL_VERSION) {
          this.flash('El emisor usa otra versión de DualSound. Recarga la página en ambos teléfonos.');
          this.send({ t: 'helloAck', v: S.PROTOCOL_VERSION, name: deviceName() });
          return;
        }
        this.hostName = msg.name;
        this.state = 'connected';
        this.send({ t: 'helloAck', v: S.PROTOCOL_VERSION, name: `${deviceName()} · ${this.code}` });
        this.startClockSync();
        break;
      case 'pong':
        this.clock.add({ t0: msg.t0, t1: msg.t1, t2: msg.t2, t3: arrival });
        break;
      case 'settings':
        this.player.setVolume(msg.volume);
        this.player.setDelay(msg.delayMs);
        break;
      case 'track':
        await this.receiveTrackHeader(msg);
        break;
      case 'chunk':
        await this.receiveChunk(msg);
        break;
      case 'play':
        this.pendingPlay = msg;
        this.applyPendingPlay();
        break;
      case 'stop':
        this.pendingPlay = null;
        this.player.stop();
        break;
      default:
        break;
    }
  }

  startClockSync() {
    clearInterval(this.pingTimer);
    this.clock.reset();
    let burst = 0;
    const ping = () => {
      this.pingId += 1;
      this.send({ t: 'ping', id: this.pingId, t0: now() });
    };
    // Ráfaga inicial para converger rápido; luego uno por segundo.
    this.pingTimer = setInterval(() => {
      ping();
      burst += 1;
      if (burst === 10) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(ping, 1000);
      }
    }, 60);
  }

  async receiveTrackHeader(msg) {
    this.pendingPlay = null;
    this.player.setTrack(null, false);
    this.track = { id: msg.id, kind: msg.kind, name: msg.name, ready: false };
    if (msg.kind === 'click') {
      this.player.setTrack(this.player.makeClickBuffer(), true);
      this.trackReady();
    } else {
      this.assembler = new S.FileAssembler(msg.id, msg.size, msg.count);
      if (msg.count === 0) await this.finishFile();
    }
  }

  async receiveChunk(msg) {
    const asm = this.assembler;
    if (!asm || msg.id !== asm.id) return;
    asm.add(msg.i, msg.data);
    if (asm.received % 16 === 0) this.send({ t: 'progress', id: asm.id, progress: asm.progress });
    if (asm.complete) await this.finishFile();
  }

  async finishFile() {
    const asm = this.assembler;
    this.assembler = null;
    try {
      const buffer = await this.player.decode(asm.assemble());
      if (this.track?.id !== asm.id) return; // Llegó otra pista mientras tanto.
      this.player.setTrack(buffer, false);
      this.trackReady();
    } catch (e) {
      const message = `No se pudo decodificar «${this.track?.name}» en este teléfono: formato no compatible.`;
      this.flash(message);
      this.send({ t: 'error', message });
    }
  }

  trackReady() {
    this.track.ready = true;
    this.send({ t: 'progress', id: this.track.id, progress: 1 });
    this.send({ t: 'ready', id: this.track.id });
    this.applyPendingPlay();
  }

  applyPendingPlay() {
    const msg = this.pendingPlay;
    if (msg && this.track?.ready && msg.id === this.track.id) {
      this.player.play(msg.anchor);
    }
  }

  async unlock() {
    const ok = await this.player.unlock();
    if (!ok) this.flash('El navegador no permitió activar el audio. Toca el botón otra vez.');
    this.player.startFromAnchor();
  }

  sendStatus() {
    if (!this.conn?.open) return;
    this.send({
      t: 'status',
      unlocked: this.player.unlocked,
      clockSynced: this.clock.isSynced,
      rtt: this.clock.bestRoundTrip,
      playing: this.player.playing,
      error: this.player.playing ? this.player.lastError : null,
      rate: this.player.rate,
      latency: this.player.reportedLatency,
      trackId: this.track?.id ?? null,
      ready: !!this.track?.ready,
    });
  }

  flash(message) {
    this.messages = [message, ...this.messages.filter((m) => m !== message)].slice(0, 4);
  }
}

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------

let host = null;
let receiver = null;

function showView() {
  const route = location.hash.replace('#', '');
  const isHost = route === 'emisor';
  const isReceiver = route === 'receptor';
  // Un mismo teléfono no puede ser emisor y receptor a la vez.
  if (isHost && receiver) { location.hash = 'receptor'; return; }
  if (isReceiver && host) { location.hash = 'emisor'; return; }
  $('view-home').hidden = isHost || isReceiver;
  $('view-host').hidden = !isHost;
  $('view-receiver').hidden = !isReceiver;
  $('back').hidden = !(isHost || isReceiver);
  if (isHost && !host) setupHost();
  if (isReceiver && !receiver) setupReceiver();
}

function checkSupport() {
  if (!Peer || !(window.RTCPeerConnection)) {
    return 'Este navegador no soporta conexiones directas (WebRTC). Usa Safari en iPhone o Chrome en Android, actualizados.';
  }
  if (!(window.AudioContext || window.webkitAudioContext)) {
    return 'Este navegador no soporta Web Audio.';
  }
  return null;
}

function setupHost() {
  host = new Host();
  window.dualsoundHost = host; // Para depuración y pruebas automáticas.
  const unsupported = checkSupport();
  if (unsupported) { host.flash(unsupported); } else { host.start(); }

  $('host-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    $('host-track').textContent = `Cargando «${file.name}»…`;
    host.player.unlock(); // Aprovecha el gesto del usuario para habilitar el audio.
    await host.loadFile(file);
  });
  $('host-click').addEventListener('click', () => {
    host.player.unlock();
    host.loadClickTrack();
  });
  $('host-play').addEventListener('click', () => {
    if (host.anchor) host.pause(); else host.play();
  });
  $('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    host.addReceiver($('connect-code').value);
    $('connect-code').value = '';
    $('connect-code').blur();
  });
  $('local-enabled').addEventListener('change', (e) => host.player.setMuted(!e.target.checked));
  createControls($('local-controls'), {
    volume: 1,
    delayMs: 0,
    onVolume: (v) => host.player.setVolume(v),
    onDelay: (ms) => host.player.setDelay(ms),
  });
  setInterval(renderHost, 400);
  renderHost();
}

const RECEIVER_STATES = {
  connecting: ['Conectando…', 'info'],
  reconnecting: ['Reconectando…', 'fair'],
  connected: ['Conectado', 'good'],
  'not-found': ['No encontrado: revisa el código', 'poor'],
  incompatible: ['Versión distinta: recarga ambas páginas', 'poor'],
};

function receiverCard(r) {
  if (r.card) return r.card;
  const card = document.createElement('div');
  card.className = 'receiver';
  card.innerHTML = `
    <div class="receiver-head">
      <span class="dot"></span>
      <div><div class="name"></div><div class="status"></div></div>
      <button type="button" class="remove" aria-label="Quitar receptor">✕</button>
    </div>
    <div class="controls"></div>
    <dl class="metrics">
      <dt>Canción</dt><dd class="m-transfer">—</dd>
      <dt>Reloj (ida y vuelta)</dt><dd class="m-clock">—</dd>
      <dt>Error de sincronía</dt><dd class="m-error">—</dd>
      <dt>Latencia informada</dt><dd class="m-latency">—</dd>
    </dl>`;
  card.querySelector('.remove').addEventListener('click', () => host.removeReceiver(r.code));
  createControls(card.querySelector('.controls'), {
    volume: r.volume,
    delayMs: r.delayMs,
    onVolume: (v) => { r.volume = v; host.send(r, { t: 'settings', volume: r.volume, delayMs: r.delayMs }); },
    onDelay: (ms) => { r.delayMs = ms; host.send(r, { t: 'settings', volume: r.volume, delayMs: r.delayMs }); },
  });
  $('receivers').appendChild(card);
  r.card = card;
  return card;
}

function renderHost() {
  const h = host;
  const playing = !!h.anchor;
  $('host-track').textContent = h.track ? h.track.name : 'Sin audio seleccionado';
  $('host-time').textContent = h.track && !h.track.loop
    ? `${S.formatTime(h.position)} / ${S.formatTime(h.player.duration)}`
    : S.formatTime(h.position);
  $('host-play').disabled = !h.track;
  $('host-play').textContent = playing ? '❚❚' : '▶︎';
  $('host-play').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');

  $('local-error').textContent = h.player.playing ? S.formatMs(h.player.lastError, { signed: true }) : '—';
  $('local-latency').textContent = S.formatMs(h.player.reportedLatency, { digits: 0 });

  const errors = [];
  if (!h.player.muted && h.player.playing) errors.push(h.player.lastError);
  let clockReady = true;
  const messages = [];
  if (h.peerError) messages.push(h.peerError);
  if (h.peer && !h.peer.open && !h.peerError) messages.push('Conectando con el servidor de emparejamiento…');

  for (const r of h.receivers.values()) {
    const card = receiverCard(r);
    const [label, color] = RECEIVER_STATES[r.state] || [r.state, 'info'];
    const s = r.status;
    card.querySelector('.name').textContent = r.name;
    let statusText = label;
    if (r.state === 'connected' && s) {
      if (!s.unlocked) statusText = 'Conectado · falta tocar «Activar audio» en el receptor';
      else if (s.playing) statusText = 'Conectado · reproduciendo';
    }
    card.querySelector('.status').textContent = statusText;
    card.querySelector('.dot').className = `dot ${r.state === 'connected' && s && !s.unlocked ? 'fair' : color}`;
    let transfer = '—';
    if (h.track && r.state === 'connected') {
      transfer = r.readyTrackId === h.track.id ? 'Lista' : `Recibiendo ${Math.round((r.transferProgress || 0) * 100)} %`;
    }
    card.querySelector('.m-transfer').textContent = transfer;
    card.querySelector('.m-clock').textContent = s?.clockSynced ? S.formatMs((s.rtt ?? 0) / 1000) : (s ? 'sincronizando…' : '—');
    card.querySelector('.m-error').textContent = s?.playing ? S.formatMs(s.error, { signed: true }) : '—';
    card.querySelector('.m-latency').textContent = s ? S.formatMs(s.latency, { digits: 0 }) : '—';

    if (r.state === 'connected' && playing) {
      if (!s?.clockSynced) clockReady = false;
      if (s?.playing) errors.push(s.error);
      if (s && !s.unlocked) messages.push(`${r.name}: toca «Activar audio» en ese teléfono para que suene.`);
    }
  }
  renderQuality($('host-quality'), S.syncQuality(errors, { clockReady, playing }));
  renderMessages($('host-messages-card'), $('host-messages'), [...messages, ...h.messages]);
}

function setupReceiver() {
  receiver = new Receiver();
  window.dualsoundReceiver = receiver;
  const unsupported = checkSupport();
  if (unsupported) { receiver.flash(unsupported); } else { receiver.start(); }
  $('rx-unlock').addEventListener('click', () => receiver.unlock());
  setInterval(renderReceiver, 400);
  renderReceiver();
}

const RX_STATES = {
  starting: 'Preparando…',
  waiting: 'Esperando al emisor…',
  connected: 'Conectado',
  offline: 'Sin conexión con el servidor de emparejamiento',
};

function renderReceiver() {
  const r = receiver;
  const p = r.player;
  $('rx-code').textContent = r.code ? `${r.code.slice(0, 3)} ${r.code.slice(3)}` : '······';
  $('rx-unlock').hidden = p.unlocked;
  let state = RX_STATES[r.state] || r.state;
  if (r.state === 'connected') state = p.playing ? `Reproduciendo · ${r.hostName}` : `Conectado a ${r.hostName}`;
  $('rx-state').textContent = state;

  $('rx-track').textContent = r.track?.name || '—';
  if (r.assembler) $('rx-transfer').textContent = `${Math.round(r.assembler.progress * 100)} %`;
  else $('rx-transfer').textContent = r.track ? (r.track.ready ? 'Lista' : 'Decodificando…') : '—';
  $('rx-clock').textContent = r.clock.isSynced ? `±${S.formatMs(r.clock.bestRoundTrip / 2000)}` : (r.conn ? 'sincronizando…' : '—');
  $('rx-error').textContent = p.playing ? S.formatMs(p.lastError, { signed: true }) : '—';
  $('rx-rate').textContent = p.playing ? `${((p.rate - 1) * 100).toFixed(3).replace('.', ',')} %` : '—';
  $('rx-latency').textContent = S.formatMs(p.reportedLatency, { digits: 0 });
  $('rx-settings').textContent = `${Math.round(p.volume * 100)} % · ${S.formatMs(p.delayMs / 1000, { signed: true, digits: 0 })}`;
  renderQuality($('rx-quality'), S.syncQuality([p.lastError], { clockReady: r.clock.isSynced, playing: p.playing }));

  const messages = [];
  if (!p.unlocked) messages.push('Toca «Activar audio»: el navegador no deja sonar audio sin un toque.');
  renderMessages($('rx-messages-card'), $('rx-messages'), [...messages, ...r.messages]);
}

window.addEventListener('hashchange', showView);
showView();
