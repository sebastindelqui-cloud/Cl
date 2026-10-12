# Limitaciones de iOS investigadas

Este documento resume qué permite y qué no permite iOS a una app de terceros
para reproducir audio en dos parlantes Bluetooth, y por qué DualSound usa la
arquitectura que usa. Solo se consideran API públicas y documentadas: nada de
API privadas ni jailbreak.

## Resumen

| Alternativa | ¿Dos parlantes Bluetooth genéricos desde un iPhone? | Notas |
|---|---|---|
| `AVAudioSession` / rutas de salida | **No** | iOS activa una sola ruta Bluetooth A2DP a la vez. |
| `AVAudioSession` categoría `multiRoute` | **No** | Reparte audio entre USB, HDMI, audífonos con cable, etc. No entre dos A2DP. |
| `AVAudioEngine` / `AVAudioPlayerNode` | **No por sí solo** | Reproducen hacia la ruta que fije la sesión de audio, que es una sola. |
| Core Bluetooth | **No** | Solo Bluetooth LE (GATT) para datos. No accede a perfiles de audio (A2DP/HFP). |
| Bluetooth LE Audio / Auracast | **No (sin API pública)** | No hay API para que una app emita LE Audio ni Auracast. Pocos parlantes lo soportan. |
| "Compartir audio" | **No** | Solo con AirPods y Beats compatibles. |
| AirPlay 2 (`longFormAudio`) | **Sí, pero solo parlantes AirPlay 2** | El usuario marca varios parlantes en el selector y iOS los sincroniza. |
| Dos dispositivos + red local (DualSound) | **Sí** | Cada parlante va a un dispositivo distinto. La sincronización se hace por software. |
| Transmisor Bluetooth "dual link" | **Sí** | Necesita comprar hardware. Fuera del alcance de la app. |

## Detalle

### AVAudioSession y rutas de salida
- `AVAudioSession.currentRoute.outputs` puede listar varias salidas solo en
  casos concretos (p. ej., AirPlay agrupado o `multiRoute` con USB/HDMI).
- Para Bluetooth clásico, el sistema mantiene **una** salida A2DP activa. Una
  app no puede "agregar" un segundo parlante.
- La app tampoco puede emparejar parlantes ni elegir la salida por código:
  la única vía pública para cambiar la salida es `AVRoutePickerView`, que abre
  el mismo selector del Centro de control. DualSound la usa en los botones
  "Seleccionar parlante 1/2".

### Categoría `multiRoute`
Está pensada para, por ejemplo, un DJ que manda la mezcla a una interfaz USB y
la preescucha a unos audífonos con cable. Apple no la documenta para dos
salidas Bluetooth, y en la práctica el sistema no expone dos A2DP a la vez.

### AVAudioEngine y AVAudioPlayerNode
Sirven para programar audio con precisión de muestra en un instante del reloj
del sistema (`play(at:)` con `AVAudioTime(hostTime:)`). DualSound los usa en
cada dispositivo para que el audio salga exactamente cuando corresponde. Pero
siguen limitados a la ruta única de la sesión.

### Core Bluetooth
Core Bluetooth solo expone Bluetooth de baja energía (GATT: servicios y
características). El audio Bluetooth clásico (A2DP para música, HFP para
llamadas) lo maneja solo el sistema operativo. **No** se puede transmitir
música a un parlante con Core Bluetooth.

### Bluetooth LE Audio y Auracast
LE Audio (LC3) y su modo de difusión Auracast permitirían, en teoría, mandar
un flujo a varios parlantes. A la fecha de este documento Apple no publica
una API para que una app emita audio LE ni cree una difusión Auracast, y la
gran mayoría de los parlantes del mercado no lo soportan. **Si Apple publica
una API así en el futuro**, DualSound podría agregar un modo de un solo
dispositivo para parlantes compatibles (ver "Cómo ampliarlo" en el README).

### AirPlay 2
Con `AVAudioSession` en categoría `.playback` y política `.longFormAudio`, una
app de audio puede ser enviada a **varios parlantes AirPlay 2** a la vez. El
usuario los marca en el selector y iOS se encarga de sincronizarlos (con un
búfer de unos 2 s). DualSound lo ofrece como "Modo AirPlay 2". No sirve para
parlantes que solo tienen Bluetooth.

### Spotify, Apple Music y otras apps de streaming
Su audio está cifrado (DRM). iOS no permite que una app capture el audio de
otra app. DualSound solo puede reproducir archivos de audio a los que tiene
acceso: los que el usuario elige en la app Archivos (MP3, M4A/AAC, WAV, AIFF,
FLAC, ALAC). Para Spotify, las alternativas reales están fuera de la app:
Spotify Jam, un computador con salida múltiple, un Samsung con "Audio dual", o
un transmisor Bluetooth dual.

## Conclusión
Con un solo iPhone y API públicas **no** es posible hacer sonar dos parlantes
Bluetooth genéricos a la vez. La alternativa más viable sin comprar hardware
es la arquitectura C: **dos dispositivos iOS**, cada uno con su parlante, y
sincronización de audio por la red local. Es lo que implementa DualSound.
