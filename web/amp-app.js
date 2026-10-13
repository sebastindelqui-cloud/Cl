// Interfaz del amplificador: lista de canciones, reproducción y controles.

import { Amplifier, PRESETS, meterPercent } from './amp.js';
import { formatTime } from './sync.js';

const $ = (id) => document.getElementById(id);
const audio = $('amp-audio');
const amp = new Amplifier(audio);
window.dualsoundAmp = amp; // Para depuración y pruebas automáticas.

const playlist = []; // { name, url }
let current = -1;

// --- Ajustes (se recuerdan entre visitas) -------------------------------------

try {
  const saved = JSON.parse(localStorage.getItem('dualsound.amp') || 'null');
  if (saved) amp.settings = { ...amp.settings, ...saved };
} catch { /* sin almacenamiento */ }

function saveSettings() {
  try { localStorage.setItem('dualsound.amp', JSON.stringify(amp.settings)); } catch { /* ignorar */ }
}

function renderSettings() {
  const s = amp.settings;
  $('amp-boost').value = s.boostDb;
  $('amp-bass').value = s.bassDb;
  $('amp-compress').checked = s.compress;
  $('amp-boost-value').textContent = `+${s.boostDb} dB`;
  $('amp-bass-value').textContent = `+${s.bassDb} dB`;
  for (const b of document.querySelectorAll('[data-preset]')) {
    const p = PRESETS[b.dataset.preset];
    const active = p.boostDb === s.boostDb && p.bassDb === s.bassDb && p.compress === s.compress;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
}

function update(changes) {
  amp.set(changes);
  saveSettings();
  renderSettings();
}

for (const b of document.querySelectorAll('[data-preset]')) {
  b.addEventListener('click', () => update({ ...PRESETS[b.dataset.preset] }));
}
$('amp-boost').addEventListener('input', (e) => update({ boostDb: Number(e.target.value) }));
$('amp-bass').addEventListener('input', (e) => update({ bassDb: Number(e.target.value) }));
$('amp-compress').addEventListener('change', (e) => update({ compress: e.target.checked }));

// --- Lista de canciones ---------------------------------------------------------

$('amp-files').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  await amp.init(); // Aprovecha el toque del usuario para habilitar el audio.
  const wasEmpty = playlist.length === 0;
  for (const file of files) {
    playlist.push({ name: file.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(file) });
  }
  renderList();
  if (wasEmpty) load(0, true);
});

function renderList() {
  const list = $('amp-list');
  list.innerHTML = '';
  playlist.forEach((item, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.name;
    button.className = i === current ? 'current' : '';
    button.addEventListener('click', async () => {
      await amp.init();
      load(i, true);
    });
    li.appendChild(button);
    list.appendChild(li);
  });
  const has = playlist.length > 0;
  $('amp-play').disabled = !has;
  $('amp-prev').disabled = !has;
  $('amp-next').disabled = !has;
  $('amp-seek').disabled = !has;
}

function load(index, autoplay) {
  if (index < 0 || index >= playlist.length) return;
  current = index;
  audio.src = playlist[index].url;
  $('amp-track').textContent = playlist[index].name;
  renderList();
  updateMediaSession();
  if (autoplay) play();
}

async function play() {
  await amp.init();
  try {
    await audio.play();
  } catch {
    $('amp-limit').textContent = 'No se pudo reproducir este archivo. Prueba con otro formato (MP3 o M4A).';
  }
}

$('amp-play').addEventListener('click', () => (audio.paused ? play() : audio.pause()));
$('amp-prev').addEventListener('click', () => {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else load(Math.max(0, current - 1), !audio.paused);
});
$('amp-next').addEventListener('click', () => load((current + 1) % playlist.length, !audio.paused));
audio.addEventListener('ended', () => {
  if (current + 1 < playlist.length) load(current + 1, true);
});
audio.addEventListener('play', () => { $('amp-play').textContent = '❚❚'; $('amp-play').setAttribute('aria-label', 'Pausar'); });
audio.addEventListener('pause', () => { $('amp-play').textContent = '▶︎'; $('amp-play').setAttribute('aria-label', 'Reproducir'); });
audio.addEventListener('error', () => {
  if (current >= 0) $('amp-limit').textContent = `No se pudo abrir «${playlist[current].name}»: formato no compatible o archivo protegido.`;
});

let seeking = false;
$('amp-seek').addEventListener('input', () => { seeking = true; });
$('amp-seek').addEventListener('change', (e) => {
  if (Number.isFinite(audio.duration)) audio.currentTime = (e.target.value / 1000) * audio.duration;
  seeking = false;
});

// Controles en la pantalla de bloqueo / Centro de control, cuando el navegador lo permite.
function updateMediaSession() {
  if (!('mediaSession' in navigator) || current < 0) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: playlist[current].name, artist: 'Amplificador' });
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => $('amp-prev').click());
  navigator.mediaSession.setActionHandler('nexttrack', () => $('amp-next').click());
}

// --- Medidor ---------------------------------------------------------------------

function frame() {
  const { rmsDb } = amp.level();
  const fill = $('amp-meter');
  fill.style.width = `${meterPercent(rmsDb)}%`;
  const limiting = amp.limiting;
  fill.classList.toggle('hot', limiting < -3);
  if (!audio.paused) {
    $('amp-limit').textContent = limiting < -0.5
      ? `Limitador activo (${limiting.toFixed(1).replace('.', ',')} dB): evita que el sonido se sature`
      : ' ';
  }
  const d = audio.duration;
  $('amp-time').textContent = Number.isFinite(d)
    ? `${formatTime(audio.currentTime)} / ${formatTime(d)}`
    : formatTime(audio.currentTime);
  if (!seeking && Number.isFinite(d) && d > 0) $('amp-seek').value = Math.round((audio.currentTime / d) * 1000);
  requestAnimationFrame(frame);
}

renderSettings();
renderList();
requestAnimationFrame(frame);
