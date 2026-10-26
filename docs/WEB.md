# DualSound Web

Versión que funciona **solo con el navegador**: no hace falta Mac, computador ni
instalar nada. Es la opción gratuita para usar DualSound sin Mac.

**Dirección (una vez publicada):** https://sebastindelqui-cloud.github.io/Cl/

## Publicarla desde el iPhone (una sola vez)

1. En Safari, abre https://github.com/sebastindelqui-cloud/Cl/settings/pages
   (pide la versión de escritorio si no ves "Settings": botón **aA** › *Solicitar sitio web de escritorio*).
2. En **Build and deployment › Source** elige **GitHub Actions**.
3. Ve a la pestaña **Actions** › **Publicar versión web** › **Run workflow**.
4. En uno o dos minutos la página estará en la dirección de arriba.

Cada cambio posterior en `web/` se publica solo.

## Ruta CR (buses de Costa Rica)

`buses.html` es una app de buses para Costa Rica: **https://sebastindelqui-cloud.github.io/Cl/buses.html**

- **Al abrir pide tu ubicación** y la usa como punto de salida.
- **Destino:** toca el mapa o escribe una parada, dirección o lugar.
- **Opciones de viaje con horarios reales:** a qué hora pasa el bus, cuándo
  llegas, cuánto caminas y el pasaje en colones según la zona (tarifa mínima,
  media o completa). Detalle paso a paso y botón para abrir el viaje en Google Maps.
- **Paradas con el rótulo azul de parada de bus**, próximos buses en cada parada y
  horario completo de cada ruta.
- **Adulto mayor (Ley 7935):** gratis en rutas de menos de 25 km, 50 % entre 25 y
  50 km y 75 % en más de 50 km (se activa en Ajustes).
- **Mapa normal o satélite.** Con una clave de Google Maps se usa el mapa de
  Google; sin clave, un mapa gratuito (OpenStreetMap y Esri).

### Datos

Por ahora tiene las 3 rutas de **Transportes San Gabriel** (San José –
Desamparados – Aserrí – San Gabriel – Acosta – Turrujal): 184 paradas reales,
recorridos y 215 salidas por semana. Vienen del GTFS publicado por el proyecto
[TC-691 "Tropicalización de la Tecnología"](https://github.com/tropicalizacion/buses)
de la Universidad de Costa Rica (versión 2021.07b, copiada en `web/data/gtfs-tsg/`).
Las tarifas son las de esos datos; ARESEP las ajusta, así que pueden haber cambiado.

Para agregar más rutas: consigue el GTFS de la empresa (formato estándar de
transporte público), ponlo en una carpeta y conviértelo:

```sh
cd web
node tools/gtfs-to-network.mjs data/gtfs-tsg data/cr-network.json
```

### Clave de Google Maps (opcional)

1. En https://console.cloud.google.com/google/maps-apis/start crea un proyecto.
2. Activa **Maps JavaScript API** y **Geocoding API**.
3. En **Credenciales** crea una **clave de API** y limítala a
   `sebastindelqui-cloud.github.io/*`.
4. Pégala en la app (⚙️ Ajustes) o en `web/config.js` para que la usen todos.

## Amplificador (un solo teléfono)

`amplificador.html` sube el volumen y los graves de **tus propias canciones**.
Es un modo aparte que no necesita un segundo teléfono:
**https://sebastindelqui-cloud.github.io/Cl/amplificador.html**

- **Modos:** Normal, Fuerte y Máximo. También se puede ajustar a mano el
  volumen extra (hasta +18 dB) y los graves (hasta +12 dB).
- **Compresor:** acerca las partes suaves a las fuertes, para que la canción
  suene más fuerte en promedio.
- **Limitador final:** impide que el sonido se sature (no pasa de 0 dB).
- **Lista de canciones:** elige varias de la app Archivos; pasa a la siguiente
  sola. Los ajustes se recuerdan entre visitas.
- **Limitaciones:** no puede subir el volumen de Spotify ni de otras apps (iOS
  no lo permite), ni hacer que el parlante supere su potencia física. La
  página debe quedar abierta mientras suena.

Prueba automática (`npm run e2e:amp`): una canción bajita sube unos 15 dB en
modo Máximo, y una canción fuerte queda con un pico de −0,7 dB, sin saturar.

## Uso

1. Conecta el **parlante 1** por Bluetooth a tu iPhone y el **parlante 2** al
   otro teléfono (iPhone o Android).
2. Abre la dirección en **los dos** teléfonos, en el mismo WiFi.
3. Otro teléfono › **Receptor** › **Activar audio**. Anota el código de 6 números.
4. Tu iPhone › **Emisor** › escribe el código › **Conectar**.
5. **Elegir canción…** (de la app Archivos) o **Pista de calibración**, y toca ▶︎.
6. Si oyes eco, reproduce la pista de calibración y sube el **retardo** del
   parlante que suena *antes*, de 5 en 5 ms, hasta oír un solo clic.

Consejos:
- Deja las dos pantallas encendidas y la página abierta. Safari pausa el audio
  si bloqueas el teléfono o cambias de app. La página pide mantener la pantalla
  encendida, pero no todos los navegadores lo permiten.
- En iPhone, desactiva el modo silencio si no suena. En iOS 17 o posterior la
  página ya lo evita por su cuenta.
- Puedes agregar la página a la pantalla de inicio: botón compartir › *Agregar a inicio*.

## Cómo funciona

```
Parlante 1 ◄─BT─ Teléfono EMISOR ══ WebRTC (WiFi) ══► Teléfono RECEPTOR ─BT─► Parlante 2
                       │                                     │
                       └──── servidor PeerJS (solo para que se encuentren) ────┘
```

1. **Emparejamiento:** el receptor se registra en el servidor público gratuito
   de PeerJS con el identificador `dualsound-v1-<código>`. El emisor lo busca
   por ese código y ambos abren una conexión **WebRTC directa**. A partir de
   ahí la música y la sincronización no pasan por ningún servidor.
2. **Transferencia:** el emisor envía el archivo completo en trozos de 64 KB
   (con control de flujo) y cada teléfono lo decodifica con Web Audio. La pista
   de calibración no se envía: cada teléfono la genera igual.
3. **Reloj:** el receptor mide el desfase con el reloj del emisor con pings
   estilo NTP (ráfaga de 10 y luego 1 por segundo) y filtro de mínimo RTT.
4. **Ancla:** al pulsar ▶︎, el emisor publica "la posición X suena en el
   instante T de mi reloj", con T = ahora + 1,2 s.
5. **Programación:** cada teléfono traduce T a su reloj de audio con
   `AudioContext.getOutputTimestamp()`, que ya incluye la latencia de salida
   que conoce el navegador. Si el navegador no lo soporta, usa `outputLatency`.
   Luego arranca el audio con `AudioBufferSourceNode.start(when, offset)`.
6. **Deriva:** cada 0,5 s se compara la posición que suena con la esperada.
   Los errores pequeños se corrigen con `playbackRate` (±0,2 %, inaudible) y
   los mayores de 35 ms se resuelven volviendo a programar el arranque.
7. **Reconexión:** si se corta, el emisor reintenta solo. El receptor conserva
   su código al recargar la página. Al volver, recibe la pista y el ancla y se
   suma a la canción en curso.

### Mensajes (PeerJS, serialización binaria)

| `t` | Sentido | Contenido |
|---|---|---|
| `hello` | E → R | `v` (versión), `name` |
| `helloAck` | R → E | `v`, `name` |
| `ping` / `pong` | R → E / E → R | `id`, `t0` / `id`, `t0`, `t1`, `t2` (ms de `performance.now()`) |
| `settings` | E → R | `volume` (0–1), `delayMs` |
| `track` | E → R | `id`, `kind` (`file`/`click`), `name`, `size`, `count` |
| `chunk` | E → R | `id`, `i`, `data` (ArrayBuffer) |
| `progress` | R → E | `id`, `progress` (0–1) |
| `ready` | R → E | `id` (pista decodificada) |
| `play` | E → R | `id`, `anchor: { startHost, offset }` |
| `stop` | E → R | — |
| `status` | R → E | `unlocked`, `clockSynced`, `rtt`, `playing`, `error`, `rate`, `latency`, `trackId`, `ready` |
| `error` | R → E | `message` |

## Archivos

```
web/
├── index.html          # Interfaz (español, pensada para iPhone)
├── style.css           # Modo claro y oscuro
├── app.js              # Audio sincronizado, PeerJS, emisor y receptor
├── sync.js             # Lógica pura: reloj, ancla, deriva, transferencia
├── amplificador.html   # Amplificador de volumen (un solo teléfono)
├── amp.js / amp-app.js # Cadena de audio del amplificador e interfaz
├── buses.html / buses.css / buses-app.js  # Ruta CR: interfaz
├── buses-core.js       # Planificador con horarios reales y tarifas por zona
├── buses-map.js        # Mapa: Google Maps o respaldo gratuito
├── config.js           # Clave de Google Maps (opcional)
├── data/               # GTFS de Transportes San Gabriel y red convertida
├── tools/gtfs-to-network.mjs  # Convierte un GTFS al formato de la app
├── vendor/             # PeerJS 1.5.4 y Leaflet 1.9.4 (MIT / BSD-2), incluidos para no depender de un CDN
└── test/
    ├── sync.test.js    # Pruebas unitarias (node --test)
    ├── e2e.mjs         # Emisor + receptor en dos Chromium con servidor PeerJS local
    ├── buses.test.js   # Planificador, tarifas y conversión del GTFS
    └── buses-e2e.mjs   # Ruta CR en Chromium
```

## Pruebas

```sh
cd web
npm install
npm test        # pruebas unitarias
npm run e2e     # prueba de extremo a extremo (Chromium headless)
npm run e2e:buses  # Ruta CR: ubicación, buscar viaje, rutas
```

La prueba de extremo a extremo hace todo esto: empareja por código, sincroniza
el reloj, toca la pista de calibración, envía y decodifica un archivo WAV,
pausa, recarga el receptor a mitad de canción (reconexión) y llega al final de
la pista. Exige un error de sincronía menor de 5 ms. GitHub Actions la ejecuta
en cada cambio.

**Qué no cubre:** las dos páginas corren en la misma máquina, con el mismo
reloj y sin Bluetooth. No mide:
- el desfase real entre dos teléfonos por WiFi;
- la latencia de cada parlante Bluetooth, que el navegador no siempre informa bien;
- el comportamiento de Safari en iPhone.

Eso hay que probarlo en teléfonos reales, con las pruebas manuales de
[PRUEBAS.md](PRUEBAS.md). Lo más probable es que haya que calibrar el retardo a
oído.

## Limitaciones propias de la versión web

- Solo funciona con la **página abierta y la pantalla encendida**.
- La sincronía es algo menos precisa que la app nativa, porque el navegador
  informa la latencia de salida con menos exactitud.
- Depende del servidor público de PeerJS para emparejar. Si no está disponible,
  los teléfonos no se encuentran. Se puede usar un servidor propio con
  `?peerHost=…&peerPort=…`.
- La página no puede ver ni elegir el parlante: se elige en el Centro de
  control del iPhone o en los ajustes de Bluetooth.
- Spotify, Apple Music y otros servicios con DRM no se pueden usar.
- Algunas redes (WiFi de invitados, redes corporativas) bloquean la conexión
  directa entre dispositivos. En ese caso, usa una red doméstica o el punto de
  acceso de uno de los teléfonos.
