# DualSound

App para iPhone que reproduce la misma música, sincronizada, en **dos
parlantes Bluetooth de cualquier marca**.

> **Limitación importante.** iOS solo permite que un iPhone envíe audio a
> **un** parlante Bluetooth a la vez, y ninguna API pública de Apple permite
> evitarlo (ver [docs/LIMITACIONES.md](docs/LIMITACIONES.md)). Por eso
> DualSound usa **dos dispositivos iOS**: cada parlante se conecta a uno, y la
> app los sincroniza por WiFi con una precisión de pocos milisegundos.
> **Necesitas un segundo iPhone, iPad o iPod touch** para el parlante 2.

## Cómo funciona

```
 Parlante 1 ◄─BT─ iPhone EMISOR ══ WiFi ══► iPhone/iPad RECEPTOR ─BT─► Parlante 2
                  (elige la música)          (DualSound en modo Receptor)
```

- El **emisor** lee un archivo de audio, lo reproduce en su parlante y lo
  envía al receptor con marcas de tiempo.
- El **receptor** sincroniza su reloj con el emisor y reproduce cada bloque
  en el mismo instante, compensando la latencia Bluetooth y la deriva de los
  relojes.
- **Modo AirPlay 2** (extra): si tus parlantes son AirPlay 2, un solo iPhone
  basta.

Detalles técnicos y protocolo: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

### Qué hace y qué no

| ✅ Hace | ❌ No hace |
|---|---|
| Parlantes Bluetooth de marcas distintas | Dos parlantes Bluetooth desde un solo iPhone (iOS no lo permite) |
| Sincronía automática + ajuste manual de retardo por parlante | Spotify / Apple Music (audio protegido con DRM) |
| Reproducir, pausar, reanudar y volumen por parlante desde el emisor | Receptores Android (el protocolo está documentado para hacerlo) |
| Reconexión automática y recuperación ante cortes | Funcionar sin el segundo dispositivo |
| Pista de calibración para alinear parlantes a oído | |

## Estructura

```
.
├── project.yml                 # Definición del proyecto Xcode (XcodeGen)
├── App/                        # App iOS (SwiftUI)
│   ├── DualSoundApp.swift
│   ├── Info.plist              # Permisos: red local, Bonjour, audio en 2.º plano
│   ├── Audio/                  # AVAudioSession, salida sincronizada, decodificador
│   ├── Network/                # Network.framework: TCP + Bonjour, reconexión
│   ├── Session/                # Motores de emisor y receptor, modelos de vista
│   ├── AirPlay/                # Modo AirPlay 2
│   └── UI/                     # Vistas SwiftUI (en español)
├── Core/                       # Paquete Swift DualSoundCore (lógica pura + pruebas)
│   ├── Sources/DualSoundCore/  # Protocolo, reloj, línea de tiempo, deriva…
│   └── Tests/DualSoundCoreTests/
├── docs/
│   ├── LIMITACIONES.md         # Investigación de API de iOS
│   ├── ARQUITECTURA.md         # Diseño y protocolo de sincronización
│   └── PRUEBAS.md              # Compatibilidad y pruebas manuales
└── .github/workflows/ci.yml    # Pruebas + compilación en macOS
```

## Compilar y ejecutar

Necesitas una **Mac con Xcode 15 o posterior** (iOS 16+ en los dispositivos).
Con una cuenta de Apple gratuita puedes instalar la app en tus dispositivos,
pero la firma gratuita vence a los 7 días y hay que volver a instalar.

1. Instala XcodeGen y genera el proyecto:
   ```sh
   brew install xcodegen
   xcodegen generate
   open DualSound.xcodeproj
   ```
2. En Xcode, abre el target **DualSound** › *Signing & Capabilities*:
   - Elige tu equipo (*Team*), aunque sea tu cuenta personal.
   - Cambia el *Bundle Identifier* por uno propio (p. ej.
     `com.tunombre.dualsound`).
3. Conecta el primer iPhone, elígelo como destino y pulsa ▶︎ (Run). Repite
   con el segundo dispositivo.
4. En cada dispositivo, la primera vez: Ajustes › General › VPN y gestión de
   dispositivos › confía en tu certificado de desarrollador. En iOS 16 o
   posterior, activa también el **Modo de desarrollador**.

### Pruebas automáticas

```sh
swift test --package-path Core
```

GitHub Actions corre esas pruebas y compila la app para el simulador en cada
push.

## Uso

1. Empareja el **parlante 1** con el iPhone emisor y el **parlante 2** con el
   receptor (Ajustes › Bluetooth).
2. En el receptor: abre DualSound › **Receptor**. Deja la pantalla abierta.
3. En el emisor: DualSound › **Emisor** › "Seleccionar parlante 2" y elige el
   receptor.
4. Elige un archivo de audio (o la pista de calibración) y pulsa ▶︎.
5. Si oyes eco, reproduce la **pista de calibración** y ajusta el **retardo**
   del parlante que suena antes, hasta oír un solo clic.

Acepta el permiso de **Red local** en los dos dispositivos. Si lo negaste:
Ajustes › Privacidad y seguridad › Red local › DualSound.

## Precisión esperada

- **Reloj entre dispositivos:** ±1–3 ms en un WiFi doméstico normal.
- **Programación del audio:** precisión de muestra (`AVAudioPlayerNode.play(at:)`),
  con corrección continua de deriva (±0,2 % de velocidad, imperceptible).
- **Latencia propia de cada parlante:** iOS la informa, pero no siempre con
  exactitud. Por eso existe el ajuste manual. Una vez calibrado un par de
  parlantes, el valor se mantiene mientras uses los mismos.
- **Retardo al iniciar:** unos 0,8 s desde que pulsas ▶︎.

Las pruebas en dispositivos reales están pendientes. Ver
[docs/PRUEBAS.md](docs/PRUEBAS.md).

## Cómo ampliarlo

- **Receptor Android:** implementar el protocolo de
  [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) con `NsdManager` (Bonjour) y
  `AudioTrack` con marcas de tiempo (`AudioTrack.getTimestamp`). Así un
  celular Android viejo podría ser el receptor.
- **Calibración automática:** usar el micrófono del emisor para medir el
  desfase acústico entre los dos parlantes con la pista de clics y ajustar el
  retardo solo.
- **Música de la biblioteca:** agregar `MPMediaPickerController` para
  canciones sin DRM sincronizadas desde un computador.
- **Compresión:** enviar AAC u Opus en vez de PCM para redes WiFi débiles.
- **LE Audio / Auracast:** si Apple publica una API para emitir audio LE,
  agregar un modo de un solo dispositivo para parlantes compatibles.
