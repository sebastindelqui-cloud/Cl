# Arquitectura y protocolo de sincronización

## Arquitecturas evaluadas

| | Arquitectura | Ventajas | Limitaciones | Decisión |
|---|---|---|---|---|
| A | Una app que usa las salidas que iOS permite | Sin hardware extra | iOS permite una sola salida A2DP: **no cumple el objetivo** | Se usa solo para elegir el parlante de cada dispositivo |
| B | Accesorio transmisor con dos receptores | Latencia baja, sirve con Spotify | Hay que comprarlo; la app no aporta nada | Se documenta como alternativa |
| C | Dos dispositivos con app complementaria y flujo sincronizado | Parlantes de cualquier marca, sin comprar nada, sincronía de pocos ms | Requiere un segundo iPhone/iPad/iPod. Solo archivos propios (no Spotify) | **Elegida** |
| D | AirPlay 2 | Un solo iPhone, sincronía hecha por iOS | Solo parlantes AirPlay 2, no Bluetooth genéricos | Incluida como modo secundario |

## Componentes

```
┌──────────────────────── iPhone EMISOR ────────────────────────┐
│ AudioFileSource / ClickTrackSource  (lee PCM 48 kHz por posición)
│            │
│      HostStreamer ── línea de tiempo (ancla: cuadro N ↔ instante T)
│        │        └──► SyncedAudioOutput ──► Parlante 1 (Bluetooth)
│        ▼
│  RemoteReceiver ×N  (TCP + Bonjour, reconexión automática)
└────────┼───────────────────────────────────────────────────────┘
         │  WiFi / red local (o WiFi directo entre iPhones)
┌────────▼──────────── iPhone/iPad RECEPTOR ────────────────────┐
│ ReceiverEngine ── ClockSynchronizer (pings estilo NTP)
│        └──► SyncedAudioOutput ──► Parlante 2 (Bluetooth)
└────────────────────────────────────────────────────────────────┘
```

- **`Core/` (DualSoundCore):** lógica pura y probada con pruebas unitarias:
  protocolo binario, entramado TCP, sincronización de reloj, línea de tiempo,
  control de deriva, historial de bloques y pista de calibración.
- **`App/Audio`:** sesión de audio (`AVAudioSession`), salida sincronizada
  (`AVAudioEngine` + `AVAudioPlayerNode` + `AVAudioUnitVarispeed`) y
  decodificación de archivos (`AVAudioFile` + `AVAudioConverter`).
- **`App/Network`:** `Network.framework` (TCP, Bonjour `_dualsound._tcp`).
- **`App/Session`:** motores de emisor y receptor, y modelos de vista.
- **`App/UI`:** SwiftUI.

## Principio de sincronización

1. **Reloj común.** El reloj del emisor es la referencia. Cada receptor mide
   su desfase con pings estilo NTP (`t0..t3`): ráfaga de 10 pings al
   conectarse y luego uno por segundo. De las últimas 20 mediciones se usa la
   de menor tiempo de ida y vuelta (filtro de mínimo RTT). Su error está
   acotado por RTT/2, normalmente 1–3 ms en WiFi doméstico.
2. **Línea de tiempo.** Al pulsar Reproducir, el emisor fija un ancla: el
   cuadro `anchorFrame` debe sonar en el instante `anchorHostTime` = ahora +
   0,8 s. Desde ahí, el cuadro `f` suena en
   `anchorHostTime + (f − anchorFrame) / 48000`.
3. **Programación.** Cada dispositivo calcula el instante local en que debe
   *entregar* cada cuadro al hardware:
   `T_local = T_emisor(f) − desfase − latenciaSalida + retardoManual`.
   `latenciaSalida = AVAudioSession.outputLatency + ioBufferDuration`, que en
   Bluetooth incluye el retardo A2DP que informa iOS. El primer bloque se
   inicia con `AVAudioPlayerNode.play(at:)` en ese instante exacto; el resto se
   programa en posiciones de muestra explícitas.
4. **Deriva.** Cada 250 ms se compara el cuadro que realmente se entrega con
   el esperado. `DriftController` corrige errores pequeños con un ajuste de
   velocidad de hasta ±0,2 % (`AVAudioUnitVarispeed`, imperceptible) y pide
   una reprogramación inmediata si el error supera 40 ms.
5. **Calibración manual.** iOS no siempre informa con exactitud la latencia
   interna de cada parlante (depende de la marca y el códec). La pista de
   calibración emite un clic cada 0,5 s. Ajustando el retardo de cada parlante
   (±5 ms por toque) se deja de oír el "doble clic".

## Búfer, latencia y recuperación

- **Búfer:** el emisor mantiene 1,5 s de audio enviado por delante del
  instante actual. Un corte de WiFi menor que eso no se oye.
- **Bloques tardíos:** si un bloque llega cuando su momento ya pasó, se
  descarta (deja un silencio de 20 ms) en vez de reproducirse desfasado. El
  contador "Bloques que llegaron tarde" lo muestra.
- **Desconexión del receptor:** el emisor reintenta la conexión con espera
  exponencial (1, 2, 4, 8 s…). Al reconectar le envía la línea de tiempo y los
  bloques recientes del historial (3 s), así el receptor se suma a la canción
  en curso.
- **Cambio o desconexión del parlante:** al cambiar la ruta, la latencia
  cambia o el motor de audio se reinicia; `SyncedAudioOutput` lo detecta y
  reprograma con los bloques retenidos.
- **Pausa/reanudar:** pausar calcula el cuadro que estaba sonando, envía
  `stop` y, al reanudar, crea una nueva sesión (`streamID`) con un ancla nueva
  desde ese cuadro.

## Protocolo de red (versión 1)

Transporte: TCP sin Nagle (`noDelay`) y con keepalive. Descubrimiento:
Bonjour `_dualsound._tcp`. Los **receptores anuncian** el servicio y el
**emisor se conecta** a los que elija el usuario.

Cada mensaje: `longitud: UInt32 BE` (bytes de tipo + cuerpo) · `tipo: UInt8` ·
`cuerpo`. Enteros y flotantes en big-endian (IEEE-754), salvo las muestras de
audio, que van en little-endian. Cadenas: `UInt16 BE` de longitud + UTF-8.
Tamaño máximo de mensaje: 1 MiB.

| Tipo | Nombre | Sentido | Cuerpo |
|---|---|---|---|
| 1 | `hello` | E → R | `version u16`, `hostName str`, `sampleRate u32`, `channels u8` |
| 2 | `helloAck` | R → E | `version u16`, `receiverName str` |
| 3 | `clockPing` | R → E | `id u32`, `t0 f64` (reloj del receptor, s) |
| 4 | `clockPong` | E → R | `id u32`, `t0 f64`, `t1 f64`, `t2 f64` (reloj del emisor) |
| 5 | `play` | E → R | `streamID u32`, `anchorFrame i64`, `anchorHostTime f64`, `sampleRate f64` |
| 6 | `audio` | E → R | `streamID u32`, `startFrame i64`, `channels u8`, `frameCount u32`, `muestras i16 LE × frameCount × channels` |
| 7 | `stop` | E → R | `streamID u32` |
| 8 | `setVolume` | E → R | `volume f32` (0…1) |
| 9 | `setDelay` | E → R | `delay f64` (s, positivo = más tarde) |
| 10 | `status` | R → E | `isPlaying u8`, `clockSynced u8`, `clockRTT f32`, `buffered f32`, `syncError f32` (NaN = sin medición), `outputLatency f32`, `outputName str`, `droppedChunks u32` |

Secuencia típica:

```
Emisor                                   Receptor
  │──── TCP connect (Bonjour) ─────────────►│
  │──── hello ─────────────────────────────►│
  │◄─── helloAck ───────────────────────────│
  │◄─── clockPing ×10 (50 ms) ──────────────│
  │──── clockPong ×10 ─────────────────────►│
  │──── setVolume, setDelay ───────────────►│
  │──── play(ancla) ───────────────────────►│
  │──── audio … audio … (50/s) ────────────►│
  │◄─── status (cada 0,5 s) ────────────────│
  │◄─── clockPing (cada 1 s) ───────────────│
  │──── stop ──────────────────────────────►│
```

Formato del audio: PCM 16 bits, 48 kHz, estéreo, bloques de 960 cuadros
(20 ms, 3,8 KB): unos 1,5 Mbit/s por receptor, cómodo para cualquier WiFi.

El protocolo es independiente de Apple: un receptor para Android (o una
Raspberry Pi) puede implementarse siguiendo esta tabla.
